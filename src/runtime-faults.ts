import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { locked, missing } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import {
	groupRuntimeFaults,
	runtimeFaultInput,
	runtimeFaultRecord,
	type RuntimeFaultRecord,
	runtimeFaultText,
} from './runtime-fault-model.ts';
import { storageRoot } from './store.ts';

export const FAULT_SEGMENT_BYTES = 512 * 1024;
export const FAULT_ARCHIVES = 3;
const archiveName = /^\d{17}-[a-f0-9-]{36}\.jsonl$/;
const currentName = 'current.jsonl';

async function checked(path: string, directory: boolean, lock = false): Promise<boolean> {
	try {
		const stat = await lstat(path);
		if (
			stat.isSymbolicLink() ||
			(directory ? !stat.isDirectory() : !stat.isFile() || (!lock && stat.nlink !== 1))
		)
			throw new Error('Runtime fault storage is redirected or has an unexpected type.');
		return true;
	} catch (error: unknown) {
		if (missing(error)) return false;
		throw error;
	}
}

async function directory(create: boolean, root: string): Promise<string | undefined> {
	if (!(await checked(root, true))) {
		if (!create) return undefined;
		throw new Error('Runtime fault team root is missing.');
	}
	let parent = root;
	for (const name of ['logs', 'runtime-faults']) {
		parent = join(parent, name);
		if (!(await checked(parent, true))) {
			if (!create) return undefined;
			await mkdir(parent, { mode: 0o700 });
			await checked(parent, true);
		}
	}
	return parent;
}

async function segment(path: string): Promise<{ bytes: number; records: RuntimeFaultRecord[] }> {
	if (!(await checked(path, false))) return { bytes: 0, records: [] };
	const stat = await lstat(path);
	if (stat.size > FAULT_SEGMENT_BYTES)
		throw new Error('Runtime fault journal exceeds its fixed segment limit.');
	const raw = await readFile(path, 'utf8');
	try {
		if (raw && !raw.endsWith('\n')) throw new Error('Partial record.');
		return {
			bytes: Buffer.byteLength(raw),
			records: raw
				.split('\n')
				.filter(Boolean)
				.map((line) => runtimeFaultRecord.parse(JSON.parse(line) as unknown)),
		};
	} catch {
		throw new Error('Runtime fault journal is damaged; existing evidence was not overwritten.');
	}
}

async function archives(root: string): Promise<string[]> {
	return (await readdir(root))
		.filter((name) => archiveName.test(name))
		.sort()
		.reverse();
}

/** Trusted window only. Named CLI sessions have a reader, never a write endpoint. */
export async function appendRuntimeFault(
	input: unknown,
	windowStartedAt: string,
	teamRoot = storageRoot(),
): Promise<RuntimeFaultRecord> {
	operatorOnly();
	const root = resolve(teamRoot);
	const entry = runtimeFaultInput.parse(input);
	const record = runtimeFaultRecord.parse({
		...entry,
		text: runtimeFaultText(entry.text),
		id: randomUUID(),
		at: new Date().toISOString(),
		windowStartedAt,
	});
	if (!(await checked(root, true))) throw new Error('Runtime fault team root is missing.');
	// The shared lock implementation deliberately hard-links its candidate to the lock path.
	await checked(join(root, 'runtime-faults.lock'), false, true);
	// Lock outside the created directory so simultaneous first faults cannot race its mkdir.
	return locked(join(root, 'runtime-faults.lock'), async () => {
		const journal = await directory(true, root);
		if (!journal) throw new Error('Runtime fault storage is unavailable.');
		const current = join(journal, currentName);
		const previous = await segment(current);
		const line = `${JSON.stringify(record)}\n`;
		if (previous.bytes + Buffer.byteLength(line) > FAULT_SEGMENT_BYTES) {
			const stamp = new Date().toISOString().replace(/\D/g, '');
			await rename(current, join(journal, `${stamp}-${randomUUID()}.jsonl`));
		}
		for (const name of (await archives(journal)).slice(FAULT_ARCHIVES)) {
			const path = join(journal, name);
			await checked(path, false);
			await unlink(path);
		}
		const handle = await open(current, 'a', 0o600);
		try {
			await handle.writeFile(line, 'utf8');
			await handle.sync();
		} finally {
			await handle.close();
		}
		return record;
	});
}

export async function readRuntimeFaults(options: {
	limit: number;
	member?: string;
	since?: string;
}) {
	const root = await directory(false, resolve(storageRoot()));
	if (!root)
		return {
			entries: [],
			retainedOccurrences: 0,
			more: false,
			maximumBytes: 4 * FAULT_SEGMENT_BYTES,
		};
	for (let attempt = 0; attempt < 3; attempt++) {
		const before = (await archives(root)).slice(0, FAULT_ARCHIVES);
		const names = [...before, currentName];
		const retained = (await Promise.all(names.map((name) => segment(join(root, name)))))
			.flatMap((value) => value.records)
			.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
		const matching = retained.filter(
			(entry) =>
				(options.member === undefined || entry.member === options.member) &&
				(options.since === undefined || Date.parse(entry.at) >= Date.parse(options.since)),
		);
		const entries = groupRuntimeFaults(matching);
		if (
			JSON.stringify(before) !==
			JSON.stringify((await archives(root)).slice(0, FAULT_ARCHIVES))
		)
			continue;
		return {
			snapshotOnly: true,
			entries: entries.slice(0, options.limit),
			retainedOccurrences: retained.length,
			matchingOccurrences: matching.length,
			more: entries.length > options.limit,
			maximumBytes: 4 * FAULT_SEGMENT_BYTES,
			repeatWindowSeconds: 60,
			oldestRetainedAt: retained[0]?.at ?? null,
		};
	}
	throw new Error('Runtime fault journals changed during reading; retry the read.');
}
