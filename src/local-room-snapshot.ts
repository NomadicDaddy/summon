import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { LocalEvent } from './local-room.ts';

import { openLocalHistory } from './local-room-segments.ts';
import { missing, optionalText } from './mail-files.ts';

/**
 * One validated Room history for receivers, extended rather than rebuilt (Summon v1.2 read load,
 * design scratch/shared/jimmy/summon-room-read-load-design.md). Archives are immutable and named by
 * range and digest, so a live-file change re-reads only the live file and a rotation reads only the
 * new archive; any other change (an archive removed, replaced under the same name or not
 * continuing the range) rebuilds by the full validated visit. Writers never use this: they scan
 * fresh under the Room lock.
 */
export interface HistorySnapshot {
	readonly events: readonly LocalEvent[];
	readonly through: number;
	readonly liveStart: number;
}

type Validate = (item: unknown, id: number, previous: LocalEvent[]) => boolean;

interface Archive {
	name: string;
	first: number;
	last: number;
	digest: string;
	stat: string;
}

interface Held extends HistorySnapshot {
	path: string;
	signature: string;
	archives: Archive[];
}

const archiveName = /^events-([1-9]\d*)-([1-9]\d*)-([a-f0-9]{64})\.json$/;

type Kind = 'file' | 'directory';

/**
 * A path's lstat as text, refusing what the full reader refuses (local-room-segments.ts): an
 * archive folder that is not a real directory, and an archive that is not a regular file, either
 * one a symbolic link (Morgan and Roger on 4ef56fc). A missing path reads as 'missing'.
 */
async function statText(path: string, kind?: Kind): Promise<string> {
	const info = await lstat(path, { bigint: true }).catch((error: unknown) => {
		if (missing(error)) return undefined;
		throw error;
	});
	if (!info) return 'missing';
	if (kind === 'directory' && (!info.isDirectory() || info.isSymbolicLink()))
		throw new Error('Invalid local room archive directory.');
	if (kind === 'file' && (!info.isFile() || info.isSymbolicLink()))
		throw new Error('Invalid room archive file.');
	return `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

/** The live file's and every archive's lstat, as roomQueryCache signed them (Roger on #43364). */
async function listing(path: string): Promise<{ signature: string; archives: Archive[] }> {
	const root = join(dirname(path), 'archive');
	const rootStat = await statText(root, 'directory');
	const names = await readdir(root).catch((error: unknown) => {
		if (missing(error)) return [];
		throw error;
	});
	const archives: Archive[] = [];
	for (const name of names.sort()) {
		const match = archiveName.exec(name);
		if (!match) continue;
		archives.push({
			name,
			first: Number(match[1]),
			last: Number(match[2]),
			digest: match[3] ?? '',
			stat: await statText(join(root, name), 'file'),
		});
	}
	archives.sort((a, b) => a.first - b.first || a.last - b.last);
	const signature = JSON.stringify([path, await statText(path), rootStat, archives]);
	return { signature, archives };
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const inner of Object.values(value)) deepFreeze(inner);
		Object.freeze(value);
	}
	return value;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function historyReader(validate: Validate) {
	let held: Held | undefined;
	let building: Promise<HistorySnapshot> | undefined;

	/** Add one event after `events`, or check it against the one already held at its id. */
	const extend = (events: LocalEvent[], item: unknown, id: number): void => {
		const first = events[0]?.id ?? id;
		if (id < first + events.length) {
			// Already validated: any difference means history changed under us (Morticia 1 and 2).
			if (!same(events[id - first], item))
				throw new Error('Conflicting local room history records.');
			return;
		}
		if (id !== first + events.length) throw new Error('Invalid local room history.');
		const answer = (item as Partial<LocalEvent> | null)?.answer;
		const question = answer ? events[answer.questionId - first] : undefined;
		if (!validate(item, id, question ? [question] : []))
			throw new Error('Invalid local room history.');
		// A frozen copy: the rebuild path's items belong to the segment reader's archive cache,
		// which writers also read, so they stay as they were (Morticia 5Q-1 on 4ef56fc).
		events.push(deepFreeze(structuredClone(item) as LocalEvent));
	};

	/**
	 * Extend `from` by new archives and the live file, or undefined when only a rebuild will do. It
	 * is only a shortcut: any difference from what is held, gap or invalid event sends the caller
	 * to the full visit, which throws as today when history really is invalid (Morticia 1).
	 */
	const incremental = async (
		from: Held,
		path: string,
		archives: Archive[],
	): Promise<{ events: LocalEvent[]; liveStart: number } | undefined> => {
		try {
			return await extendFrom(from, path, archives);
		} catch {
			return undefined;
		}
	};

	const extendFrom = async (
		from: Held,
		path: string,
		archives: Archive[],
	): Promise<{ events: LocalEvent[]; liveStart: number } | undefined> => {
		const kept = new Map(from.archives.map((archive) => [archive.name, archive.stat]));
		const added = archives.filter((archive) => !kept.has(archive.name));
		// Every archive the snapshot was built from must still be there, unchanged by lstat.
		if (archives.length - added.length !== from.archives.length) return undefined;
		if (
			archives.some(
				(archive) => kept.has(archive.name) && kept.get(archive.name) !== archive.stat,
			)
		)
			return undefined;
		const events = [...from.events];
		const root = join(dirname(path), 'archive');
		for (const archive of added) {
			const text = await optionalText(join(root, archive.name));
			if (!text || createHash('sha256').update(text).digest('hex') !== archive.digest)
				throw new Error('Invalid local room archive digest.');
			const items: unknown = JSON.parse(text);
			if (!Array.isArray(items) || items.length !== archive.last - archive.first + 1)
				throw new Error('Invalid local room archive range.');
			items.forEach((item, index) => extend(events, item, archive.first + index));
		}
		const raw = await optionalText(path);
		const live: unknown = raw ? JSON.parse(raw) : [];
		if (!Array.isArray(live)) throw new Error('Invalid local room history.');
		const liveStart = live.length ? (live[0] as LocalEvent).id : 1;
		if (archives.length && !live.length) throw new Error('Local room live history is missing.');
		live.forEach((item, index) => extend(events, item, liveStart + index));
		// History that now ends before what was held (a truncated live file) is not an append.
		const end = live.length ? liveStart + live.length - 1 : (archives.at(-1)?.last ?? 0);
		if (end !== (events.at(-1)?.id ?? 0)) return undefined;
		return { events, liveStart };
	};

	/** Today's full validated visit, the fallback for anything but an append or a rotation. */
	const rebuild = async (path: string): Promise<{ events: LocalEvent[]; liveStart: number }> => {
		const history = await openLocalHistory(path, true);
		const events: LocalEvent[] = [];
		await history.visit((item, id) => extend(events, item, id));
		return { events, liveStart: history.liveStart };
	};

	const build = async (path: string): Promise<HistorySnapshot> => {
		// Every call reads every archive's lstat (Roger on #43364), so an archive replaced or
		// corrupted in place is refused on the next read, as before this change.
		const before = await listing(path);
		if (held?.path === path && held.signature === before.signature) return held;
		const grown =
			held?.path === path ? await incremental(held, path, before.archives) : undefined;
		const { events, liveStart } = grown ?? (await rebuild(path));
		const next: Held = {
			path,
			signature: before.signature,
			archives: before.archives,
			events: Object.freeze(events),
			through: events.at(-1)?.id ?? 0,
			liveStart,
		};
		// Publish only a build whose inputs held still while it ran (Roger on #43364).
		if ((await listing(path)).signature === before.signature) held = next;
		return next;
	};

	/**
	 * The current snapshot. One build at a time (Morticia 4): a caller waits for a build in flight,
	 * then starts its own, which returns at once when nothing changed. A failed build drops the
	 * snapshot and throws, as today's visit throws on unreadable or invalid history.
	 */
	return async (path: string): Promise<HistorySnapshot> => {
		while (building) await building.catch(() => undefined);
		building = build(path);
		try {
			return await building;
		} catch (error: unknown) {
			held = undefined;
			throw error;
		} finally {
			building = undefined;
		}
	};
}
