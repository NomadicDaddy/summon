import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { rotateCommittedEvents } from '../src/local-room-storage.ts';
import {
	appendLocalEvent,
	cachedLocalEvents,
	type LocalEvent,
	localEvents,
	localPage,
	localRoomPath,
	localTail,
} from '../src/local-room.ts';
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

async function seed(count = 1200): Promise<LocalEvent[]> {
	const events: LocalEvent[] = Array.from({ length: count }, (_, index) => ({
		id: index + 1,
		at: new Date().toISOString(),
		sender: { kind: 'user', id: 'operator' },
		text: `Event ${index + 1}`,
		replyTo: null,
		source: 'local',
	}));
	await mkdir(join(fixture.records, 'room'));
	await writeFile(localRoomPath(), JSON.stringify(events));
	return events;
}
const append = (text: string, replyTo: number | null = null) =>
	appendLocalEvent({
		sender: { kind: 'user', id: 'operator' },
		text,
		replyTo,
		source: 'local',
	});
const live = async (): Promise<LocalEvent[]> =>
	JSON.parse(await readFile(localRoomPath(), 'utf8')) as LocalEvent[];

test('rotation bounds the live file, preserves IDs, old pages, replies and cache invalidation', async () => {
	await seed();
	const before = await cachedLocalEvents();
	expect((await append('Next', 1)).id).toBe(1201);
	expect(await live()).toHaveLength(1001);
	expect((await live())[0]?.id).toBe(201);
	expect(await localEvents()).toHaveLength(1201);
	expect(before).toHaveLength(1200);
	expect(await cachedLocalEvents()).not.toBe(before);
	expect((await localPage(0)).events[0]?.id).toBe(1);
	expect((await localPage(195)).events.map((event) => event.id)).toEqual(
		Array.from({ length: 20 }, (_, index) => index + 196),
	);
	expect(await localTail(300)).toBe(901);
	expect(await localPage(1202).catch(String)).toContain('Cursor exceeds');
	const concurrent = await Promise.all([append('A'), append('B')]);
	expect(concurrent.map((event) => event.id).sort()).toEqual([1202, 1203]);
});

test('archived questions, answers and mirrored source IDs remain authoritative', async () => {
	const events = await seed();
	const [first, second, third, fourth] = events;
	if (!first || !second || !third || !fourth) throw new Error('Missing fixture events');
	events[0] = {
		...first,
		sender: { kind: 'agent', id: 'alpha' },
		text: 'Approve?',
		question: { kind: 'approval', choices: ['Yes', 'No'], allowFreeform: false },
	};
	const originalAnswer: LocalEvent = {
		...second,
		text: 'Yes',
		replyTo: 1,
		answer: { questionId: 1, choice: 0 },
	};
	const mirror: LocalEvent = { ...third, source: 'telegram:fixture:3' };
	events[1] = originalAnswer;
	events[2] = mirror;
	events[3] = {
		...fourth,
		sender: { kind: 'agent', id: 'alpha' },
		question: { kind: 'approval', choices: ['Yes', 'No'], allowFreeform: false },
	};
	await writeFile(localRoomPath(), JSON.stringify(events));
	await append('Rotate');
	expect((await appendLocalEvent(originalAnswer)).id).toBe(2);
	expect(
		await appendLocalEvent({
			...originalAnswer,
			text: 'No',
			answer: { questionId: 1, choice: 1 },
		}).catch(String),
	).toContain('already been answered');
	expect((await appendLocalEvent(mirror)).id).toBe(3);
	expect(await localEvents()).toHaveLength(1201);
	expect(
		(
			await appendLocalEvent({
				sender: { kind: 'user', id: 'operator' },
				text: 'Yes',
				replyTo: 4,
				source: 'local',
				answer: { questionId: 4, choice: 0 },
			})
		).id,
	).toBe(1202);
});

test('an interrupted archive-before-live write is replayable without loss or duplicate IDs', async () => {
	const events = await seed();
	await rotateCommittedEvents(events, 1);
	expect(await live()).toHaveLength(1200);
	expect(await localEvents()).toEqual(events);
	expect((await append('Retry')).id).toBe(1201);
	expect(await readdir(join(fixture.records, 'room', 'archive'))).toHaveLength(1);
	expect(await localEvents()).toHaveLength(1201);
});

test('failed archive write preserves the live history and next ID', async () => {
	const events = await seed();
	await writeFile(join(fixture.records, 'room', 'archive'), 'Refuse directory creation');
	expect(await append('Cannot commit').catch(String)).toContain('archive directory');
	expect(await live()).toEqual(events);
});

test('repeated rotations retain every event exactly once', async () => {
	await seed();
	for (let index = 0; index < 201; index++) await append(`Next ${index}`);
	expect(await readdir(join(fixture.records, 'room', 'archive'))).toHaveLength(2);
	expect(await live()).toHaveLength(1001);
	expect((await localEvents()).map((event) => event.id)).toEqual(
		Array.from({ length: 1401 }, (_, index) => index + 1),
	);
}, 60000);

test('conflicting overlap after interruption is rejected without rewriting either copy', async () => {
	const events = await seed();
	await rotateCommittedEvents(events, 1);
	const first = events[0];
	if (!first) throw new Error('Missing first event');
	first.text = 'Conflicting live copy';
	await writeFile(localRoomPath(), JSON.stringify(events));
	expect(await append('Cannot commit').catch(String)).toContain('Conflicting local room');
	expect(await live()).toEqual(events);
});

test('archive corruption fails closed rather than assigning reused IDs', async () => {
	await seed();
	await append('Rotate');
	const directory = join(fixture.records, 'room', 'archive');
	const file = (await readdir(directory))[0];
	if (!file) throw new Error('Missing archive');
	await writeFile(join(directory, file), '[]');
	expect(await append('Cannot commit').catch(String)).toContain('archive digest');
	expect((await live()).at(-1)?.id).toBe(1201);
});

test('a pending checkpoint receipt replays and advances across rotation', async () => {
	await seed();
	type Batch = { receipt: string; room: { events: LocalEvent[]; nextCursor: number } };
	const first = JSON.parse((await fixture.run(['--checkpoint'], 'alpha')).out) as Batch;
	await append('Rotate');
	const replay = JSON.parse((await fixture.run(['--checkpoint'], 'alpha')).out) as Batch;
	expect(replay.receipt).toBe(first.receipt);
	expect(replay.room).toEqual(first.room);
	const next = JSON.parse(
		(await fixture.run(['--checkpoint', first.receipt], 'alpha')).out,
	) as Batch;
	expect(next.room.events[0]?.id).toBe(first.room.nextCursor + 1);
});
