import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
	cachedLocalEvents,
	localEvents,
	localHead,
	localPage,
	localRoomPath,
} from '../src/local-room.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

// The receiver snapshot (Summon v1.2 read load): extended on appends and rotations, rebuilt on
// anything else, and always equal to a fresh full read (Morticia #43365, Roger #43367).

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const original = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (original === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = original;
	await fixture.dispose();
});

const event = (id: number, text = `Message ${id}`) => ({
	id,
	at: '2026-10-10T00:00:00.000Z',
	sender: { kind: 'user' as const, id: 'operator' },
	text,
	replyTo: null,
	source: 'local',
});
const range = (first: number, last: number, text?: string) =>
	Array.from({ length: last - first + 1 }, (_, index) => event(first + index, text));
async function live(first: number, last: number, text?: string): Promise<void> {
	await mkdir(join(fixture.records, 'room'), { recursive: true });
	await writeFile(localRoomPath(), JSON.stringify(range(first, last, text)));
}
const archiveRoot = () => join(fixture.records, 'room', 'archive');

async function archive(first: number, last: number, text?: string): Promise<string> {
	const body = JSON.stringify(range(first, last, text));
	const digest = createHash('sha256').update(body).digest('hex');
	await mkdir(archiveRoot(), { recursive: true });
	const path = join(archiveRoot(), `events-${first}-${last}-${digest}.json`);
	await writeFile(path, body);
	return path;
}

/** Counts reads of archive files while `run` goes. */
async function archiveReads(run: () => Promise<void>): Promise<string[]> {
	const seen: string[] = [];
	const originalRead = fs.readFile;
	const spy = spyOn(fs, 'readFile').mockImplementation(
		new Proxy(originalRead, {
			apply(target, receiver: unknown, args: unknown[]) {
				if (String(args[0]).includes('archive')) seen.push(String(args[0]));
				const result: unknown = Reflect.apply(target, receiver, args);
				return result;
			},
		}),
	);
	try {
		await run();
	} finally {
		spy.mockRestore();
	}
	return seen;
}

async function matchesFreshRead(): Promise<void> {
	expect([...(await cachedLocalEvents())]).toEqual(await localEvents());
	expect(await localHead()).toBe((await localEvents()).at(-1)?.id ?? 0);
}

test('a rotation reads only the new archive and its overlap must match what is held', async () => {
	await archive(1, 100);
	await live(101, 150);
	await matchesFreshRead();
	// Rotation: 101-130 move into a new archive; the live file keeps 131-160.
	const rotated = await archive(101, 130);
	await live(131, 160);
	// Only the snapshot's own queries are counted: a fresh full read would reopen every archive.
	const reads = await archiveReads(async () => {
		expect(await localHead()).toBe(160);
		await cachedLocalEvents();
	});
	expect(reads.length).toBeGreaterThan(0);
	expect(reads.every((path) => path === rotated)).toBe(true);
	await matchesFreshRead();
	expect((await localPage(150)).events.map((item) => item.id)).toEqual(
		range(151, 160).map((item) => item.id),
	);
});

test('a changed live prefix, an archive removed or replaced, and a truncated live file all rebuild', async () => {
	await archive(1, 50);
	await live(51, 60);
	await matchesFreshRead();
	await live(51, 61, 'edited in place');
	expect((await cachedLocalEvents()).at(-1)?.text).toBe('edited in place');
	await matchesFreshRead();
	await live(51, 55, 'edited in place');
	expect(await localHead()).toBe(55);
	await matchesFreshRead();
	const first = await archive(1, 50);
	await writeFile(first, JSON.stringify(range(1, 50, 'rewritten')));
	expect(await cachedLocalEvents().catch(String)).toContain('archive digest');
	await rm(first);
	await mkdir(archiveRoot(), { recursive: true });
	await live(1, 5);
	await matchesFreshRead();
});

test('the shared history is frozen, so a consumer cannot change the next answer', async () => {
	await live(1, 3);
	const history = await cachedLocalEvents();
	expect(() => (history as unknown as unknown[]).push(event(99))).toThrow();
	expect(() => {
		(history[0] as { text: string }).text = 'changed';
	}).toThrow();
	expect((await cachedLocalEvents()).map((item) => item.text)).toEqual([
		'Message 1',
		'Message 2',
		'Message 3',
	]);
});

test('concurrent queries across an append agree with a fresh read', async () => {
	await live(1, 10);
	const before = cachedLocalEvents();
	await live(1, 11);
	const results = await Promise.all([before, cachedLocalEvents(), localHead(), localPage(10)]);
	expect(results[1].at(-1)?.id).toBe(11);
	expect(results[2]).toBe(11);
	expect(results[3].events.map((item) => item.id)).toEqual([11]);
	await matchesFreshRead();
});

test('an unreadable live file throws as before, and the next good write recovers', async () => {
	await live(1, 3);
	await matchesFreshRead();
	await writeFile(localRoomPath(), '[{"id":1,');
	expect(await cachedLocalEvents().catch((error: unknown) => error)).toBeInstanceOf(Error);
	await live(1, 4);
	await matchesFreshRead();
});
