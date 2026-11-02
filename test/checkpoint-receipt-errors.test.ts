import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { sendHuman } from '../src/local-room-access.ts';
import { sendMessage } from '../src/mailbox.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const originalRoot = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (originalRoot === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = originalRoot;
	await fixture.dispose();
});

interface Batch {
	receipt: string;
	more: boolean;
	warning?: string;
	room?: { events: { text: string }[] };
}

test('rejected receipts explain unchanged cursors and preserve exact pending read coverage', async () => {
	await sendHuman('first');
	const first = JSON.parse((await fixture.run(['--checkpoint'], 'alpha')).out) as Batch;
	await sendHuman('second');
	const second = JSON.parse(
		(await fixture.run(['--checkpoint', first.receipt], 'alpha')).out,
	) as Batch;
	await sendHuman('third');
	const mailId = await sendMessage('beta', 'alpha', 'unread positive control');
	const third = JSON.parse(
		(await fixture.run(['--checkpoint', second.receipt], 'alpha')).out,
	) as Batch;
	const foreign = JSON.parse((await fixture.run(['--checkpoint'], 'beta')).out) as Batch;
	const checkpointBefore = await fixture.read('runtime/alpha/checkpoint.json');
	const cursorBefore = await fixture.read('runtime/alpha/room.cursor');
	const markerPath = join(fixture.records, 'mailboxes', 'alpha', 'delivery', `${mailId}.read`);
	for (const token of [
		'malformed',
		'11111111-1111-4111-8111-111111111111',
		foreign.receipt,
		first.receipt,
	]) {
		const rejected = await fixture.run(['--checkpoint', token], 'alpha');
		expect(rejected.code).toBe(1);
		expect(rejected.error).toContain('No checkpoint cursors advanced');
		expect(rejected.error).toContain('Unseen messages remain unread');
		expect(rejected.error).toContain('without a receipt to recover');
		expect(await fixture.read('runtime/alpha/checkpoint.json')).toBe(checkpointBefore);
		expect(await fixture.read('runtime/alpha/room.cursor')).toBe(cursorBefore);
		expect(await Bun.file(markerPath).exists()).toBe(false);
	}
	// The last acknowledged token remains an idempotent replay, never a rejection or new read.
	const replay = JSON.parse(
		(await fixture.run(['--checkpoint', second.receipt], 'alpha')).out,
	) as Batch;
	expect(replay.receipt).toBe(third.receipt);
	expect(replay.warning).toContain('more describes the original package');
	expect(await Bun.file(markerPath).exists()).toBe(false);
	expect(await fixture.read('runtime/alpha/room.cursor')).toBe(cursorBefore);
	// A valid positive control proves this instrument can detect real advancement.
	const final = JSON.parse(
		(await fixture.run(['--checkpoint', third.receipt], 'alpha')).out,
	) as Batch;
	expect((await fixture.run(['--checkpoint', final.receipt], 'alpha')).code).toBe(0);
	expect(await fixture.read('runtime/alpha/room.cursor')).toBe('3');
	expect(await Bun.file(markerPath).exists()).toBe(true);
});

test('replayed package excludes later work until its separate final acknowledgment', async () => {
	await sendHuman('original batch');
	const first = JSON.parse((await fixture.run(['--checkpoint'], 'alpha')).out) as Batch;
	expect(first.more).toBe(true);
	await sendHuman('later human work');
	const replay = JSON.parse((await fixture.run(['--checkpoint'], 'alpha')).out) as Batch;
	expect(replay.receipt).toBe(first.receipt);
	expect(replay.room).toEqual(first.room);
	expect(replay.more).toBe(true);
	expect(replay.warning).toContain('more describes the original package');
	expect(replay.warning).toContain('not the current backlog');
	const final = JSON.parse(
		(await fixture.run(['--checkpoint', replay.receipt], 'alpha')).out,
	) as Batch;
	expect(final.room).toBeUndefined();
	const next = JSON.parse(
		(await fixture.run(['--checkpoint', final.receipt], 'alpha')).out,
	) as Batch;
	expect(next.room?.events.map((event) => event.text)).toEqual(['later human work']);
});
