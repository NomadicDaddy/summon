import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { missing, optionalText } from './mail-files.ts';
import { roomCache } from './room-cache.ts';

const archiveName = /^events-([1-9]\d*)-([1-9]\d*)-([a-f0-9]{64})\.json$/;
interface Body {
	events: unknown[];
	bytes: number;
}
const archives = new Map<string, ReturnType<typeof roomCache<Body>>>();
const retain = (body: Body): boolean => body.bytes <= 1024 * 1024;
const cachedLive = roomCache<Body>(retain);

function eventId(value: unknown): number {
	if (
		!value ||
		typeof value !== 'object' ||
		!('id' in value) ||
		!Number.isSafeInteger(value.id) ||
		Number(value.id) < 1
	)
		throw new Error('Invalid local room event ID.');
	return Number(value.id);
}

function parseEvents(raw: string): unknown[] {
	const value: unknown = JSON.parse(raw);
	if (!Array.isArray(value)) throw new Error('Invalid local room history.');
	return value;
}

interface Segment {
	first: number;
	last: number;
	read: () => Promise<unknown[]>;
}

/** Segment metadata grows with archives; retained event bodies have a fixed cache budget. */
export async function openLocalHistory(path: string, fresh = false) {
	const read = async () => {
		const raw = await optionalText(path);
		return { events: raw ? parseEvents(raw) : [], bytes: raw ? Buffer.byteLength(raw) : 0 };
	};
	const live = (await (fresh ? read() : cachedLive(path, read))).events;
	const liveStart = live.length ? eventId(live[0]) : 1;
	if (!live.every((event, index) => eventId(event) === liveStart + index))
		throw new Error('Invalid local room live range.');
	const root = join(dirname(path), 'archive');
	const info = await lstat(root).catch((error: unknown) => {
		if (missing(error)) return undefined;
		throw error;
	});
	if (info && (!info.isDirectory() || info.isSymbolicLink()))
		throw new Error('Invalid local room archive directory.');
	const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
		if (missing(error)) return [];
		throw error;
	});
	const segments: Segment[] = [];
	for (const entry of entries) {
		const match = archiveName.exec(entry.name);
		if (!match) continue;
		if (!entry.isFile() || entry.isSymbolicLink())
			throw new Error('Invalid room archive file.');
		const first = Number(match[1]);
		const last = Number(match[2]);
		if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first)
			throw new Error('Invalid local room archive range.');
		const file = join(root, entry.name);
		segments.push({
			first,
			last,
			read: async () => {
				let cache = archives.get(file);
				if (!cache) cache = roomCache<Body>(retain);
				archives.delete(file);
				archives.set(file, cache);
				while (archives.size > 4) {
					const oldest = archives.keys().next().value;
					if (oldest !== undefined) archives.delete(oldest);
				}
				const body = await cache(file, async () => {
					const text = await optionalText(file);
					if (!text || createHash('sha256').update(text).digest('hex') !== match[3])
						throw new Error('Invalid local room archive digest.');
					const events = parseEvents(text);
					if (
						events.length !== last - first + 1 ||
						!events.every((event, index) => eventId(event) === first + index)
					)
						throw new Error('Invalid local room archive range.');
					return { events, bytes: Buffer.byteLength(text) };
				});
				return body.events;
			},
		});
	}
	if (segments.length && !live.length) throw new Error('Local room live history is missing.');
	if (live.length)
		segments.push({
			first: liveStart,
			last: liveStart + live.length - 1,
			read: () => Promise.resolve(live),
		});
	segments.sort((a, b) => a.first - b.first || a.last - b.last);
	const find = async (id: number): Promise<unknown> => {
		const segment = segments.find((part) => part.first <= id && part.last >= id);
		return segment ? (await segment.read())[id - segment.first] : undefined;
	};
	return {
		liveStart,
		find,
		visit: async (consume: (event: unknown, id: number) => Promise<void> | void) => {
			let through = 0;
			for (const segment of segments) {
				for (const event of await segment.read()) {
					const id = eventId(event);
					if (id <= through) {
						if (JSON.stringify(await find(id)) !== JSON.stringify(event))
							throw new Error('Conflicting local room history records.');
						continue;
					}
					if (id !== through + 1) throw new Error('Invalid local room history.');
					await consume(event, id);
					through = id;
				}
			}
			return through;
		},
	};
}
