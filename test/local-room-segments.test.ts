import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { openLocalHistory } from '../src/local-room-segments.ts';
import {
	appendLocalEvent,
	cachedLocalEvents,
	localPage,
	localRoomPath,
	localTail,
} from '../src/local-room.ts';
import { roomLookup } from '../src/room-lookup.ts';
import { roomProgress } from '../src/room-progress.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

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

async function archive(first: number, count: number, text?: string): Promise<string> {
	const values = Array.from({ length: count }, (_, index) => event(first + index, text));
	const body = JSON.stringify(values);
	const digest = createHash('sha256').update(body).digest('hex');
	const root = join(fixture.records, 'room', 'archive');
	await mkdir(root, { recursive: true });
	const path = join(root, `events-${first}-${first + count - 1}-${digest}.json`);
	await writeFile(path, body);
	return path;
}

test('small archive reads are reused but older entries are evicted as history grows', async () => {
	for (let id = 1; id <= 5; id++) await archive(id, 1);
	await writeFile(localRoomPath(), JSON.stringify([event(6)]));
	const snapshot = await openLocalHistory(localRoomPath());
	const first = await snapshot.find(1);
	expect(await snapshot.find(1)).toBe(first);
	for (let id = 2; id <= 5; id++) expect(await snapshot.find(id)).toEqual(event(id));
	const reread = await snapshot.find(1);
	expect(reread).toEqual(first);
	expect(reread).not.toBe(first);
});

test('oversized archived and live bodies are readable without remaining in the shared cache', async () => {
	await archive(1, 300, 'x'.repeat(4096));
	await writeFile(
		localRoomPath(),
		JSON.stringify(
			Array.from({ length: 300 }, (_, index) => event(index + 301, 'y'.repeat(4096))),
		),
	);
	const first = await openLocalHistory(localRoomPath());
	const archived = await first.find(1);
	expect(await first.find(1)).toEqual(archived);
	expect(await first.find(1)).not.toBe(archived);
	const second = await openLocalHistory(localRoomPath());
	expect(await second.find(301)).toEqual(await first.find(301));
	expect(await second.find(301)).not.toBe(await first.find(301));
	expect(await localTail(20)).toBe(580);
});

test('old pages, bounded searches and appends traverse more archives than fit in cache', async () => {
	for (let index = 0; index < 8; index++) await archive(index * 200 + 1, 200);
	await writeFile(localRoomPath(), JSON.stringify([event(1601)]));
	expect((await localPage(195)).events.map((item) => item.id)).toEqual(
		Array.from({ length: 20 }, (_, index) => index + 196),
	);
	expect(await roomLookup(['search', 'Message', '--limit', '2'])).toMatchObject({
		through: 1601,
		next: 2,
		matches: [{ id: 1 }, { id: 2 }],
	});
	expect(await roomLookup(['show', '1401'])).toMatchObject({ event: event(1401) });
	expect((await appendLocalEvent({ ...event(0), text: 'Next' })).id).toBe(1602);
	expect(JSON.parse(await readFile(localRoomPath(), 'utf8'))).toHaveLength(2);
});

test('a warm page still rejects archive corruption outside its requested range before append', async () => {
	await archive(1, 200);
	const last = await archive(201, 200);
	await writeFile(localRoomPath(), JSON.stringify([event(401)]));
	expect((await localPage(0)).events).toHaveLength(20);
	await cachedLocalEvents();
	const before = await readFile(localRoomPath(), 'utf8');
	await writeFile(last, '[]');
	expect(await localPage(0).catch(String)).toContain('archive digest');
	expect(await cachedLocalEvents().catch(String)).toContain('archive digest');
	expect(await appendLocalEvent({ ...event(0), text: 'Refuse' }).catch(String)).toContain(
		'archive digest',
	);
	expect(await readFile(localRoomPath(), 'utf8')).toBe(before);
});

test('warm roster and page polling do not reread archive bodies, including a large segment', async () => {
	await archive(1, 1200, 'x'.repeat(4096));
	for (let index = 0; index < 16; index++) await archive(1201 + index * 200, 200);
	await writeFile(localRoomPath(), JSON.stringify([event(4401)]));
	let archiveReads = 0;
	const originalRead = fs.readFile;
	const reader = spyOn(fs, 'readFile').mockImplementation(
		new Proxy(originalRead, {
			apply(target, receiver: unknown, args: unknown[]) {
				if (String(args[0]).includes('archive')) archiveReads++;
				const result: unknown = Reflect.apply(target, receiver, args);
				return result;
			},
		}),
	);
	try {
		expect(await localTail(0)).toBe(4401);
		expect((await localPage(4381)).events).toHaveLength(20);
		const history = await cachedLocalEvents();
		expect(archiveReads).toBeGreaterThan(0);
		archiveReads = 0;
		for (let index = 0; index < 20; index++) {
			expect(await roomProgress('alpha')).toEqual({ cursor: 0, head: 4401, pending: 4401 });
			expect(await localTail(20)).toBe(4381);
			expect((await localPage(4381)).events).toHaveLength(20);
			expect(await cachedLocalEvents()).toBe(history);
		}
		expect(archiveReads).toBe(0);
		await writeFile(localRoomPath(), JSON.stringify([event(4401), event(4402)]));
		expect(await localTail(0)).toBe(4402);
		expect(archiveReads).toBeGreaterThan(0);
	} finally {
		reader.mockRestore();
	}
});
