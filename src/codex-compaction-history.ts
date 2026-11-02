import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

import { compactionIdentity, retainCompaction } from './compaction-history.ts';
import { optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { deliveryStatus, runtimePath } from './mail-session.ts';
import { canonicalPath, redirectedComponent } from './path-identity.ts';

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const READ_BYTES = 64 * 1024;
const READS_PER_TICK = 8;
const header = z.object({ type: z.literal('session_meta'), payload: z.object({ id: z.string() }) });
const compacted = z.object({
	type: z.literal('compacted'),
	timestamp: z.iso.datetime(),
	payload: z.object({
		window_id: z.string().min(1).max(256),
		compaction_response_id: z.string().min(1).max(256),
	}),
});

type OpenedFile = Awaited<ReturnType<typeof open>>;

async function verifyHeader(file: OpenedFile, bound: string): Promise<void> {
	let bytes = Buffer.alloc(0);
	while (bytes.length <= MAX_LINE_BYTES) {
		const chunk = Buffer.alloc(READ_BYTES);
		const { bytesRead } = await file.read(chunk, 0, chunk.length, bytes.length);
		if (!bytesRead) throw new Error('Codex rollout header is incomplete.');
		bytes = Buffer.concat([bytes, chunk.subarray(0, bytesRead)]);
		const newline = bytes.indexOf(10);
		if (newline === -1) continue;
		const input: unknown = JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, newline)),
		);
		if (header.parse(input).payload.id !== bound)
			throw new Error('Codex rollout identity mismatch.');
		return;
	}
	throw new Error('Codex rollout header is too large.');
}

async function prefixDigest(file: OpenedFile, size: number): Promise<string> {
	const hash = createHash('sha256');
	for (let position = 0; position < size;) {
		const chunk = Buffer.alloc(Math.min(READ_BYTES, size - position));
		const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
		if (!bytesRead) throw new Error('Codex rollout prefix was truncated.');
		hash.update(chunk.subarray(0, bytesRead));
		position += bytesRead;
	}
	return hash.digest('hex');
}

/** Only the already bound thread's path is queried; titles, prompts and other rows are never read. */
async function rolloutPath(home: string, thread: string): Promise<string | undefined> {
	const root = await realpath(home);
	const databasePath = join(root, 'state_5.sqlite');
	const info = await lstat(databasePath);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
		throw new Error('Codex compaction metadata database is redirected.');
	const database = new Database(databasePath, { readonly: true });
	let row: unknown;
	try {
		database.run('PRAGMA query_only = ON');
		row = database.query('SELECT rollout_path FROM threads WHERE id = ?').get(thread);
	} finally {
		database.close();
	}
	if (row === null) return;
	const selected = z.object({ rollout_path: z.string().min(1) }).parse(row);
	const path = resolve(selected.rollout_path);
	// Links and redirected drives anywhere in the recorded path are refused. A spelling alias (an 8.3
	// short name) is neither, so containment compares the rollout's identity with the sessions root.
	if (await redirectedComponent(path)) throw new Error('Codex compaction rollout is redirected.');
	const inside = relative(join(root, 'sessions'), await canonicalPath(path));
	if (!inside || isAbsolute(inside) || inside.split(sep).includes('..'))
		throw new Error('Codex compaction rollout is outside its sessions root.');
	await lstat(path); // A bound rollout must exist, as before; the reader checks its type each tick.
	return path;
}

/** Incremental own-rollout metadata observation. Private JSON fields exist only transiently in RAM. */
export function codexCompactionReader(name: string, nonce: string) {
	ownMailbox(name);
	let thread: string | undefined;
	let path: string | undefined;
	let offset = 0;
	let partial = Buffer.alloc(0);
	let verified = false;
	let consumed = createHash('sha256');
	let fileIdentity: { ino: number; dev: number } | undefined;
	let version: string | undefined;
	let disabled = false;
	let warned = false;
	const current = async (): Promise<string | undefined> =>
		(await optionalText(join(runtimePath(name), `${nonce}.binding`))) ??
		(await deliveryStatus(name, nonce)).thread;
	return async (): Promise<boolean> => {
		if (disabled) return true;
		try {
			const bound = await current();
			if (!bound || !/^[a-zA-Z0-9_-]{8,128}$/.test(bound)) return true;
			if (thread !== bound || !path) {
				thread = bound;
				path = await rolloutPath(
					process.env.CODEX_HOME ?? join(homedir(), '.codex'),
					bound,
				);
				offset = 0;
				partial = Buffer.alloc(0);
				verified = false;
				consumed = createHash('sha256');
				fileIdentity = undefined;
				version = undefined;
			}
			if (!path) return true;
			if (await redirectedComponent(path)) throw new Error('Codex rollout was redirected.');
			const info = await lstat(path);
			if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < offset)
				throw new Error('Codex compaction rollout changed unexpectedly.');
			const file = await open(path, 'r');
			try {
				const opened = await file.stat();
				if (opened.ino !== info.ino || opened.dev !== info.dev)
					throw new Error('Codex rollout changed.');
				if (
					fileIdentity &&
					(opened.ino !== fileIdentity.ino || opened.dev !== fileIdentity.dev)
				)
					throw new Error('Codex rollout was replaced.');
				fileIdentity = { ino: opened.ino, dev: opened.dev };
				const signature = (value: typeof opened): string =>
					`${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
				const before = signature(opened);
				// A same-inode truncate/regrow is not an append. Recheck identity and all consumed bytes.
				await verifyHeader(file, bound);
				// Unrelated appends need no full-prefix work. Verify before retaining evidence below.
				let prefixVerified = offset === 0 || version === before;
				for (let count = 0; count < READS_PER_TICK; count++) {
					const chunk = Buffer.alloc(READ_BYTES);
					const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
					if (!bytesRead) break;
					const combined = Buffer.concat([partial, chunk.subarray(0, bytesRead)]);
					let beginning = 0;
					let newline: number;
					while ((newline = combined.indexOf(10, beginning)) !== -1) {
						if (newline - beginning > MAX_LINE_BYTES)
							throw new Error('Codex metadata line is too large.');
						const input: unknown = JSON.parse(
							new TextDecoder('utf-8', { fatal: true }).decode(
								combined.subarray(beginning, newline),
							),
						);
						if (!verified) {
							if (header.parse(input).payload.id !== bound)
								throw new Error('Codex rollout identity mismatch.');
							verified = true;
						} else {
							const event = compacted.safeParse(input);
							if (
								!event.success &&
								input &&
								typeof input === 'object' &&
								'type' in input &&
								input.type === 'compacted'
							) {
								disabled = true;
								throw new Error('Codex compaction metadata is invalid.');
							}
							if (event.success) {
								if ((await current()) !== bound) return true;
								await verifyHeader(file, bound);
								if (!prefixVerified) {
									if (
										(await prefixDigest(file, offset)) !==
										consumed.copy().digest('hex')
									) {
										disabled = true;
										throw new Error(
											'Codex rollout consumed prefix was rewritten.',
										);
									}
									prefixVerified = true;
								}
								await retainCompaction(name, {
									provider: 'codex',
									nonce,
									source: 'codex-rollout',
									phase: 'recorded',
									identity: compactionIdentity([
										bound,
										event.data.payload.window_id,
										event.data.payload.compaction_response_id,
									]),
									nativeAt: event.data.timestamp,
									deduplication: 'native-id',
								});
							}
						}
						beginning = newline + 1;
					}
					partial = Buffer.from(combined.subarray(beginning));
					if (partial.length > MAX_LINE_BYTES)
						throw new Error('Codex metadata line is too large.');
					consumed.update(chunk.subarray(0, bytesRead));
					offset += bytesRead;
				}
				version =
					prefixVerified && signature(await file.stat()) === before ? before : undefined;
			} finally {
				await file.close();
			}
			return offset >= info.size;
		} catch {
			// Never print a provider payload, path, database row or conversation identifier.
			if (!warned)
				console.error(
					'Codex compaction history is unavailable; retained evidence is unchanged.',
				);
			warned = true;
			return true;
		}
	};
}
