import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import type { BoardChange, BoardDocument } from './board-model.ts';

import { boardChangeSchema } from './board-model.ts';
import { atomicWrite, missing } from './mail-files.ts';
import { storageRoot } from './store.ts';

const LIVE_BYTES = 2 * 1024 * 1024;
const directory = (): string => join(storageRoot(), 'board', 'history');
const archiveSchema = z
	.object({ version: z.literal(1), changes: z.array(boardChangeSchema) })
	.strict();

/** Archive only already committed changes, before a mutation adds its own history entry. */
export async function rotateBoardHistory(data: BoardDocument): Promise<void> {
	const sizes = data.history.map((change) => Buffer.byteLength(JSON.stringify(change)) + 1);
	let bytes = sizes.reduce((sum, size) => sum + size, 2);
	if (bytes <= LIVE_BYTES) return;
	let count = 0;
	while (bytes > LIVE_BYTES / 2 && count < sizes.length) bytes -= sizes[count++] ?? 0;
	const changes = data.history.slice(0, count);
	const text = JSON.stringify({ version: 1, changes });
	// Content addressing makes a retry after archive-write/state-write interruption idempotent.
	const digest = createHash('sha256').update(text).digest('hex');
	await atomicWrite(join(directory(), `${digest}.json`), text);
	data.history = data.history.slice(count);
}

export async function archivedBoardHistory(id: string): Promise<BoardChange[]> {
	const files = await readdir(directory()).catch((error: unknown) => {
		if (!missing(error)) throw error;
		return [];
	});
	const changes: BoardChange[] = [];
	for (const file of files.sort()) {
		if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
		const raw = await readFile(join(directory(), file), 'utf8');
		const data = archiveSchema.parse(JSON.parse(raw) as unknown);
		changes.push(...data.changes.filter((change) => change.itemId === id));
	}
	return changes;
}

/** Revisions order one card's history even when the wall clock moves backwards. */
export function completeBoardHistory(changes: BoardChange[]): BoardChange[] {
	const unique = new Map<number, BoardChange>();
	for (const change of changes) {
		const previous = unique.get(change.after.revision);
		if (previous && JSON.stringify(previous) !== JSON.stringify(change))
			throw new Error('Conflicting Board history records.');
		unique.set(change.after.revision, change);
	}
	return [...unique.values()].sort((left, right) => left.after.revision - right.after.revision);
}
