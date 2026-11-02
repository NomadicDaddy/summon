import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
	compactionInput,
	type CompactionInput,
	compactionRecord,
	type CompactionRecord,
	validateCompactionSource,
} from './compaction-model.ts';
import { atomicWrite, errorCode, locked, missing } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { slugFor, storageRoot } from './store.ts';

const FILE = /^[a-f0-9]{64}\.json$/;
const MAX_BYTES = 2048;

async function checked(path: string, directory: boolean): Promise<boolean> {
	try {
		const info = await lstat(path);
		if (
			info.isSymbolicLink() ||
			(directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
		)
			throw new Error('Compaction history storage is redirected or has an unexpected type.');
		if (!directory && info.size > MAX_BYTES) throw new Error('Compaction record is too large.');
		return true;
	} catch (error: unknown) {
		if (missing(error)) return false;
		throw error;
	}
}

async function location(name: string, create: boolean): Promise<string | undefined> {
	ownMailbox(name);
	const root = resolve(storageRoot());
	if (!(await checked(root, true))) {
		if (!create) return;
		throw new Error('Compaction history team root is missing.');
	}
	let path = root;
	for (const part of ['compactions', slugFor(name)]) {
		path = join(path, part);
		if (!(await checked(path, true))) {
			if (!create) return;
			await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
				if (errorCode(error) !== 'EEXIST') throw error;
			});
			await checked(path, true);
		}
	}
	return path;
}

export function compactionIdentity(parts: readonly (string | number)[]): string {
	return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Immediate consumers are authenticated launch observers and the own-history CLI reader. */
export async function retainCompaction(name: string, input: CompactionInput): Promise<boolean> {
	const metadata = compactionInput.parse(input);
	validateCompactionSource(metadata);
	const record = compactionRecord.parse({ ...metadata, observedAt: new Date().toISOString() });
	const directory = await location(name, true);
	if (!directory) throw new Error('Compaction history is unavailable.');
	const id = compactionIdentity([metadata.provider, metadata.source, metadata.identity]);
	const path = join(directory, `${id}.json`);
	const body = JSON.stringify(record);
	if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('Compaction record is too large.');
	// Serializing creation preserves duplicate identity without exposing partially written records.
	const lock = `${directory}.lock`;
	try {
		const info = await lstat(lock);
		if (info.isSymbolicLink() || !info.isFile())
			throw new Error('Compaction history lock is redirected.');
	} catch (error: unknown) {
		if (!missing(error)) throw error;
	}
	return locked(lock, async () => {
		if (!(await checked(path, false))) {
			await atomicWrite(path, body);
			return true;
		}
		const existing = compactionRecord.parse(
			JSON.parse(await readFile(path, 'utf8')) as unknown,
		);
		validateCompactionSource(existing);
		// A resume may observe the same native event under a new launch nonce.
		const keys = [
			'provider',
			'source',
			'phase',
			'identity',
			'nativeAt',
			'deduplication',
		] as const;
		if (keys.some((key) => existing[key] !== metadata[key]))
			throw new Error('Compaction event identity was reused with different metadata.');
		return false;
	});
}

/** No initialization, deletion, transcript read or provider operation is performed by this view. */
export async function readCompactions(name: string, limit: number, before?: string) {
	const directory = await location(name, false);
	const records: { id: string; record: CompactionRecord }[] = [];
	if (directory) {
		for (const file of await readdir(directory)) {
			if (/^[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/.test(file)) continue;
			if (!FILE.test(file)) throw new Error('Unexpected compaction history file.');
			const path = join(directory, file);
			await checked(path, false);
			let record: CompactionRecord;
			try {
				record = compactionRecord.parse(
					JSON.parse(await readFile(path, 'utf8')) as unknown,
				);
				validateCompactionSource(record);
				const expected = compactionIdentity([
					record.provider,
					record.source,
					record.identity,
				]);
				if (file !== `${expected}.json`)
					throw new Error('Compaction history identity changed.');
			} catch {
				throw new Error(
					'Compaction history is damaged; existing evidence was not changed.',
				);
			}
			records.push({ id: file.slice(0, -5), record });
		}
	}
	records.sort(
		(a, b) =>
			b.record.observedAt.localeCompare(a.record.observedAt) || b.id.localeCompare(a.id),
	);
	const offset = before === undefined ? 0 : records.findIndex((entry) => entry.id === before) + 1;
	if (before !== undefined && offset === 0)
		throw new Error('Compaction history cursor is unavailable.');
	const page = records.slice(offset, offset + limit);
	const more = offset + limit < records.length;
	return {
		readOnly: true,
		snapshotOnly: true,
		member: slugFor(name),
		entries: page,
		more,
		next: more ? (page.at(-1)?.id ?? null) : null,
		retainedObservations: records.length,
	};
}
