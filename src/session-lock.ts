import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWrite, errorCode, missing } from './mail-files.ts';
import { runtimePath } from './mail-session.ts';
import { parseOwner, processAlive, type ProcessOwner } from './process-owner.ts';
import { startedAfterLock } from './process-start.ts';

export interface SessionLock {
	setChild: (pid: number) => Promise<void>;
	release: () => Promise<void>;
}

async function readOwner(path: string, strict = false): Promise<ProcessOwner | undefined> {
	try {
		const owner = parseOwner(await readFile(join(path, 'owner.json'), 'utf8'));
		if (!owner && strict)
			throw new Error('Invalid session lock; refusing a potentially duplicate launch.');
		return owner;
	} catch (error: unknown) {
		if (missing(error)) return undefined;
		throw error;
	}
}

export async function isAgentRunning(slug: string): Promise<boolean> {
	const target = join(runtimePath(slug), 'session.lock');
	const owner = await readOwner(target);
	return owner !== undefined && (await sessionOwnerRunning(target, owner));
}

async function sessionOwnerRunning(target: string, owner: ProcessOwner): Promise<boolean> {
	const pids = [owner.pid, ...(owner.childPid === undefined ? [] : [owner.childPid])];
	if (!pids.some(processAlive)) return false;
	try {
		const writtenAt = (await stat(join(target, 'owner.json'))).mtimeMs;
		for (const pid of pids) {
			if (processAlive(pid) && !(await startedAfterLock(pid, writtenAt))) return true;
		}
		return false;
	} catch {
		// A concurrent writer or inaccessible metadata cannot justify a duplicate launch.
		return true;
	}
}

/** Publish a complete owner atomically; only one competing session can acquire the directory. */
export async function acquireSessionLock(slug: string): Promise<SessionLock | undefined> {
	const root = runtimePath(slug);
	const target = join(root, 'session.lock');
	const owner: ProcessOwner = { pid: process.pid, nonce: randomUUID() };
	const candidate = join(root, `session-pending-${owner.nonce}`);
	await mkdir(candidate, { recursive: true, mode: 0o700 });
	try {
		await writeFile(join(candidate, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
		const previous = await readOwner(target, true);
		if (previous) {
			if (await sessionOwnerRunning(target, previous)) return undefined;
			// A retained nonempty tombstone makes competing stale-owner reapers safe:
			// a second reaper cannot move a new owner's lock over the old owner's tombstone.
			try {
				await rename(target, join(root, `session-stale-${previous.nonce}`));
			} catch (error: unknown) {
				if (contended(error)) return undefined;
				throw error;
			}
		}
		try {
			await rename(candidate, target);
		} catch (error: unknown) {
			if (contended(error)) return undefined;
			throw error;
		}
	} finally {
		await rm(candidate, { recursive: true, force: true });
	}
	return {
		setChild: async (pid) => {
			owner.childPid = pid;
			await atomicWrite(join(target, 'owner.json'), JSON.stringify(owner));
		},
		release: async () => {
			if ((await readOwner(target))?.nonce === owner.nonce)
				await rm(target, { recursive: true, force: true });
		},
	};
}

function contended(error: unknown): boolean {
	return ['EEXIST', 'ENOTEMPTY', 'ENOENT', 'EPERM'].includes(errorCode(error) ?? '');
}

export function alreadyRunning(name: string): void {
	console.log(`${name} is already running. Select the existing terminal tab or window.`);
}
