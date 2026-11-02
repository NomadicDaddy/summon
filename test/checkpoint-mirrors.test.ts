import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { checkpointMirrors } from '../src/checkpoint-mirrors.ts';
import { telegramHarness, update } from './fixtures/telegram-harness.ts';

test('mirror omission requires matching source, sender and exact delivered body', () => {
	const config = { botToken: '123:fixture', chatId: '456', allowedUserIds: ['456'] };
	const sender = { kind: 'user' as const, id: '456' };
	const event = {
		sequence: 1,
		messageId: 42,
		sender,
		text: 'Exact human decision',
		replyTo: null,
	};
	const local = {
		id: 7,
		at: new Date().toISOString(),
		source: 'telegram:123:456:42',
		sender,
		text: event.text,
		replyTo: null,
	};
	const room = {
		lastTeamWindowStartedAt: null,
		paused: false,
		events: [local],
		nextCursor: 7,
		more: false,
	};
	const telegram = { paused: false, events: [event], nextCursor: 1, more: false };
	expect(checkpointMirrors(room, telegram, config).events[0]).toEqual({
		...event,
		text: '',
		bodyInRoom: 7,
	});
	for (const changed of [
		{ ...local, source: 'telegram:999:456:42' },
		{ ...local, source: 'telegram:123:999:42' },
		{ ...local, text: 'Exact human' },
		{ ...local, sender: { kind: 'user' as const, id: '789' } },
		{ ...local, sender: { kind: 'agent' as const, id: '456' } },
	])
		expect(
			checkpointMirrors({ ...room, events: [changed] }, telegram, config).events[0],
		).toEqual(event);
	expect(checkpointMirrors({ ...room, events: [] }, telegram, config).events[0]).toEqual(event);
	expect(telegram.events[0]?.text).toBe(event.text);
});

interface Batch {
	receipt: string;
	changed: boolean;
	more: boolean;
	warning?: string;
	room?: { events: { id: number; text: string }[]; nextCursor: number };
	telegram?: {
		events: { sequence: number; messageId: number; text: string; bodyInRoom?: number }[];
		nextCursor: number;
	};
}

test('checkpoint mirror references replay and acknowledge both cursors without changing originals', async () => {
	const h = await telegramHarness();
	try {
		const text = 'An exact approval with details '.repeat(100).trim();
		await writeFile(join(h.root, 'updates.json'), JSON.stringify([update(42, text)]));
		expect((await h.readRoom()).events[0]?.text).toBe(text);
		const run = async (receipt?: string) => {
			const result = await h.invoke(
				receipt ? [receipt] : [],
				'success',
				'test-agent',
				'42',
				'--checkpoint',
			);
			expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: '' });
			return JSON.parse(result.out) as Batch;
		};
		const batch = await run();
		expect(batch.room?.events[0]?.text).toBe(text);
		expect(batch.telegram?.events[0]).toMatchObject({
			sequence: 1,
			messageId: 42,
			text: '',
			bodyInRoom: batch.room?.events[0]?.id,
		});
		expect(batch.telegram?.nextCursor).toBe(1);
		expect(JSON.stringify(batch).split(text)).toHaveLength(2);
		const replay = await run();
		const { warning, ...replayed } = replay;
		expect(warning).toContain('replayed');
		expect(replayed).toEqual(batch);
		const final = await run(batch.receipt);
		expect(final.changed).toBe(false);
		expect(final.more).toBe(true);
		expect((await h.readRoom()).events).toHaveLength(1);
		const last = await run(final.receipt);
		expect(last.more).toBe(false);
		expect((await h.readRoom()).events).toEqual([]);
		expect((await h.readRoom('0')).events[0]?.text).toBe(text);
		const original = await h.invoke(['read', '0'], 'success', 'test-agent', '42', '--room');
		expect(original.code).toBe(0);
		expect((JSON.parse(original.out) as { events: { text: string }[] }).events[0]?.text).toBe(
			text,
		);
		// A transport whose mirror was already acknowledged must still deliver its full body.
		await writeFile(
			join(h.root, 'updates.json'),
			JSON.stringify([update(43, 'Telegram only')]),
		);
		expect((await h.readRoom()).events[0]?.text).toBe('Telegram only');
		expect((await h.invoke(['ack', '2'], 'success', 'test-agent', '42', '--room')).code).toBe(
			0,
		);
		const skewed = await run(last.receipt);
		expect(skewed.room).toBeUndefined();
		expect(skewed.telegram?.events[0]).toMatchObject({ messageId: 43, text: 'Telegram only' });
		expect(skewed.telegram?.events[0]?.bodyInRoom).toBeUndefined();
	} finally {
		await h.dispose();
	}
}, 30_000);
