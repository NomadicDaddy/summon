import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { LocalEvent } from '../src/local-room.ts';

import { catchUpPage } from '../src/room-catch-up.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

function history(): LocalEvent[] {
	return Array.from({ length: 300 }, (_, i) => ({
		id: i + 1,
		at: '2026-09-28T00:00:00Z',
		source: 'local',
		replyTo: null,
		sender: { kind: 'agent', id: 'beta' },
		text: `Update ${i}: ${'routine detail '.repeat(120)}`,
	}));
}

function eventAt(events: LocalEvent[], index: number): LocalEvent {
	const event = events[index];
	if (!event) throw new Error('Missing fixture event.');
	return event;
}

test('routine backlog shrinks, retains provenance and never changes originals', () => {
	const all = history();
	const before = JSON.stringify(all);
	const page = catchUpPage(all, 0, 'alpha');
	expect(page.events.length).toBeGreaterThan(20);
	expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(28000);
	expect(page.events[0]?.digest?.readOriginal).toBe('summon --room read 0');
	expect(page.events[0]?.digest?.kind).toBe('excerpt');
	expect(page.events[0]?.source).toBe('local');
	expect(JSON.stringify(all)).toBe(before);
	let cursor = 0;
	const delivered: number[] = [];
	let bytes = 0;
	while (cursor < all.length) {
		const next = catchUpPage(all, cursor, 'alpha');
		delivered.push(...next.events.map((event) => event.id));
		bytes += Buffer.byteLength(JSON.stringify(next));
		cursor = next.nextCursor;
	}
	expect(delivered).toEqual(all.map((event) => event.id));
	expect(bytes).toBeLessThan(Buffer.byteLength(before) / 2);
});

test('human, CLI, mentions, own replies, images, questions and whole threads stay exact', () => {
	const all = history();
	const replace = (id: number, patch: Partial<LocalEvent>) => {
		all[id - 1] = { ...eventAt(all, id - 1), ...patch };
	};
	replace(2, { replyTo: 1 });
	replace(180, { sender: { kind: 'user', id: 'operator' }, replyTo: 2 });
	replace(3, { replyTo: 1 }); // sibling context is protected too
	replace(4, { sender: { kind: 'cli', id: 'CLI' } });
	replace(5, { text: `${eventAt(all, 4).text} @ALPHA` });
	replace(6, { text: `${eventAt(all, 5).text} @all` });
	replace(7, { sender: { kind: 'agent', id: 'alpha' } });
	replace(8, { replyTo: 7 });
	replace(9, { image: 'a'.repeat(64) });
	replace(10, { question: { kind: 'approval', choices: ['Yes', 'No'], allowFreeform: false } });
	replace(11, {
		sender: { kind: 'user', id: 'operator' },
		replyTo: 10,
		text: 'Yes',
		answer: { questionId: 10, choice: 0 },
	});
	const delivered = [];
	let cursor = 0;
	while (cursor < all.length) {
		const page = catchUpPage(all, cursor, 'alpha');
		delivered.push(...page.events);
		cursor = page.nextCursor;
	}
	for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 180, 281, 300])
		expect(delivered.find((event) => event.id === id)).toEqual(all[id - 1]);
	expect(delivered.find((event) => event.id === 12)?.digest).toBeDefined();
});

test('invalid context fails closed and escaped Unicode stays byte bounded', () => {
	const all = history();
	const first = eventAt(all, 0);
	const second = eventAt(all, 1);
	first.replyTo = 500;
	expect(() => catchUpPage(all, 0, 'alpha')).toThrow('Missing catch-up reply context');
	first.replyTo = null;
	first.sender.kind = 'user';
	first.text = '\u0001'.repeat(4096);
	second.sender.kind = 'user';
	second.text = '界'.repeat(4096);
	const page = catchUpPage(all, 0, 'alpha');
	expect(page.events).toHaveLength(1);
	expect(page.events[0]?.text).toBe(first.text);
	expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(28000);
	expect(() => catchUpPage(all, 301, 'alpha')).toThrow();
	expect(catchUpPage([], 0, 'alpha').more).toBe(false);
});

test('CLI digest replays across processes, explicit reads recover originals, receipt consumes only prior page', async () => {
	const fixture = await mailHarness();
	try {
		await mkdir(join(fixture.records, 'room'));
		const all = history();
		await Bun.write(join(fixture.records, 'room', 'events.json'), JSON.stringify(all));
		type Batch = { receipt: string; warning?: string; room: ReturnType<typeof catchUpPage> };
		const run = async (args: string[]) => {
			const result = await fixture.run(args, 'alpha');
			expect(result.code).toBe(0);
			return JSON.parse(result.out) as Batch;
		};
		const first = await run(['--checkpoint']);
		expect(first.room.catchUp).toContain('not approval');
		const retry = await run(['--checkpoint']);
		expect(retry.receipt).toBe(first.receipt);
		expect(retry.room).toEqual(first.room);
		const original = await fixture.run(['--room', 'read', '0'], 'alpha');
		expect((JSON.parse(original.out) as { events: LocalEvent[] }).events[0]).toEqual(all[0]);
		const second = await run(['--checkpoint', first.receipt]);
		expect(second.room.events[0]?.id).toBe(first.room.nextCursor + 1);
		const stale = await run(['--checkpoint', first.receipt]);
		expect(stale.room).toEqual(second.room);
		expect(stale.receipt).toBe(second.receipt);
	} finally {
		await fixture.dispose();
	}
});
