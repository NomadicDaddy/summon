import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import type { LocalEvent } from './local-room.ts';

import { openLocalHistory } from './local-room-segments.ts';
import { atomicWrite, missing } from './mail-files.ts';
import { storageRoot } from './store.ts';

const archiveRoot = (): string => join(storageRoot(), 'room', 'archive');

async function checkArchiveDirectory(): Promise<void> {
	const info = await lstat(archiveRoot()).catch((error: unknown) => {
		if (missing(error)) return undefined;
		throw error;
	});
	if (info && (!info.isDirectory() || info.isSymbolicLink()))
		throw new Error('Invalid local room archive directory.');
}

/** Preserve the complete ID space for questions, source deduplication, receipts and old cursors. */
export async function readLocalHistory(
	path: string,
	fresh = true,
): Promise<{ events: unknown[]; liveStart: number }> {
	const snapshot = await openLocalHistory(path, fresh);
	const events: unknown[] = [];
	await snapshot.visit((event) => {
		events.push(event);
	});
	return { events, liveStart: snapshot.liveStart };
}

/** Archive only committed events before the next append; overlap after interruption is exact. */
export async function rotateCommittedEvents(
	events: LocalEvent[],
	liveStart: number,
): Promise<LocalEvent[]> {
	const live = events.filter((event) => event.id >= liveStart);
	if (live.length < 1200) return live;
	const prefix = live.slice(0, -1000);
	const text = JSON.stringify(prefix);
	const digest = createHash('sha256').update(text).digest('hex');
	const file = `events-${prefix[0]?.id}-${prefix.at(-1)?.id}-${digest}.json`;
	await checkArchiveDirectory();
	await atomicWrite(join(archiveRoot(), file), text);
	return live.slice(-1000);
}
