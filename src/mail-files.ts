import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { parseOwner, processAlive } from './process-owner.ts';

const WINDOWS_RENAME_RETRY_MS = 3000;
// At 25 ms per attempt, Windows waiters outlast a replacement retry under the lock.
const DEFAULT_LOCK_ATTEMPTS = process.platform === 'win32' ? 200 : 100;

export function missing(error: unknown): boolean {
	return errorCode(error) === 'ENOENT';
}

export function errorCode(error: unknown): string | undefined {
	return error instanceof Error && 'code' in error && typeof error.code === 'string'
		? error.code
		: undefined;
}

export async function optionalText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, 'utf8');
	} catch (error: unknown) {
		if (missing(error)) return undefined;
		throw error;
	}
}

/**
 * What an atomicWrite caller can know afterwards: `renamed` once the new file is in place, or
 * `failed` when it threw before the rename, so the old file is untouched. Neither set means the
 * caller cannot tell, for instance when the write never reported back.
 */
export interface WriteProgress {
	renamed?: boolean;
	failed?: boolean;
}

export async function atomicWrite(
	path: string,
	text: string,
	progress?: WriteProgress,
): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
		const retryStartedAt = performance.now();
		for (let attempt = 0; ; attempt++) {
			try {
				await rename(temporary, path);
				if (progress) progress.renamed = true;
				break;
			} catch (error: unknown) {
				// Windows readers can deny replacement for longer than the old 550 ms retry window.
				if (
					process.platform !== 'win32' ||
					performance.now() - retryStartedAt >= WINDOWS_RENAME_RETRY_MS ||
					!['EPERM', 'EBUSY', 'EACCES'].includes(errorCode(error) ?? '')
				)
					throw error;
				await delay(Math.min(10 * 2 ** attempt, 100));
			}
		}
	} catch (error: unknown) {
		// Everything in the try precedes the rename's success, so the old file is intact.
		if (progress) progress.failed = true;
		throw error;
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

export class LockBusyError extends Error {
	readonly path: string;
	constructor(path: string) {
		super(`Mailbox operation is locked; retry after the other operation finishes: ${path}`);
		this.path = path;
	}
}

/** Windows can briefly deny opens, links or deletion while another handle is closing. */
async function lockFileOperation<T>(operation: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await operation();
		} catch (error: unknown) {
			if (
				process.platform !== 'win32' ||
				attempt >= 8 ||
				!['EPERM', 'EBUSY', 'EACCES'].includes(errorCode(error) ?? '')
			)
				throw error;
			await delay(Math.min(10 * 2 ** attempt, 100));
		}
	}
}

/** Serializes mutations; a failed operation never silently steals another writer's lock. */
export async function locked<T>(
	path: string,
	operation: () => Promise<T>,
	attempts = DEFAULT_LOCK_ATTEMPTS,
): Promise<T> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
	const candidate = `${path}.${randomUUID()}.pending`;
	await writeFile(candidate, owner, { flag: 'wx', mode: 0o600 });
	try {
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			try {
				await lockFileOperation(() => link(candidate, path));
			} catch (error: unknown) {
				if (errorCode(error) !== 'EEXIST') throw error;
				await recoverLock(path);
				if (attempt + 1 < attempts) await delay(25);
				continue;
			}
			try {
				return await operation();
			} finally {
				await lockFileOperation(() => unlink(path));
			}
		}
		throw new LockBusyError(path);
	} finally {
		await lockFileOperation(() => unlink(candidate)).catch(() => undefined);
	}
}

async function recoverLock(path: string): Promise<void> {
	const text = await lockFileOperation(() => optionalText(path));
	if (text === undefined) return;
	const owner = parseOwner(text);
	if (owner && processAlive(owner.pid)) return;
	const info = await lockFileOperation(() => lstat(path)).catch((error: unknown) => {
		if (missing(error)) return undefined;
		throw error;
	});
	if (!info || (!owner && Date.now() - info.mtimeMs < 5000)) return;
	const identity =
		owner?.nonce ??
		createHash('sha256')
			.update(`${info.dev}:${info.ino}:${info.birthtimeMs}:${info.mtimeMs}:${text}`)
			.digest('hex');
	// The retained hard link lets only one reaper remove this dead owner's lock.
	const marker = `${path}.${identity}.reaped`;
	try {
		await lockFileOperation(() => link(path, marker));
	} catch (error: unknown) {
		if (missing(error) || errorCode(error) === 'EEXIST') return;
		throw error;
	}
	// An initializer or another owner may have completed while this reaper was waiting.
	if (
		(await lockFileOperation(() => optionalText(marker))) !== text ||
		(await lockFileOperation(() => optionalText(path))) !== text
	)
		return;
	await lockFileOperation(() => unlink(path));
}
