import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { sendHuman } from '../src/local-room-access.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { startMailWatcher } from '../src/mail-watcher.ts';
import { sendMessage } from '../src/mailbox.ts';
import { WAKE_NOTICE_MAX } from '../src/room-wake.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { notifyLocalRoom } from './fixtures/wake-notice.ts';

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
	paused: boolean;
	more: boolean;
	changed: boolean;
	warning?: string;
	mail?: { messages: { header: { id: string } }[] };
	room?: { events: { id: number; text: string }[]; nextCursor: number };
}

test('combined payload defers unread mail and never archives unresolved work', async () => {
	await sendHuman('界'.repeat(4096));
	await sendHuman('界'.repeat(4096));
	const id = await sendMessage('beta', 'alpha', 'x'.repeat(16000));
	const readPath = join(fixture.records, 'mailboxes', 'alpha', 'delivery', `${id}.read`);
	const first = await fixture.run(['--checkpoint'], 'alpha');
	const batch = JSON.parse(first.out) as Batch;
	expect(Buffer.byteLength(first.out)).toBeLessThan(34000);
	expect(batch.mail).toBeUndefined();
	expect(batch.more).toBe(true);
	expect(await Bun.file(readPath).exists()).toBe(false);
	let next = JSON.parse(
		(await fixture.run(['--checkpoint', batch.receipt], 'alpha')).out,
	) as Batch;
	for (let page = 0; !next.mail && next.changed && page < 10; page++) {
		expect(await Bun.file(readPath).exists()).toBe(false);
		next = JSON.parse(
			(await fixture.run(['--checkpoint', next.receipt], 'alpha')).out,
		) as Batch;
	}
	expect(next.mail?.messages[0]?.header.id).toBe(id);
	expect(await Bun.file(readPath).exists()).toBe(false);
	const last = JSON.parse(
		(await fixture.run(['--checkpoint', next.receipt], 'alpha')).out,
	) as Batch;
	expect(last.changed).toBe(false);
	expect(await Bun.file(readPath).exists()).toBe(true);
	expect(
		await Bun.file(join(fixture.records, 'mailboxes', 'alpha', 'inbox', `${id}.md`)).exists(),
	).toBe(true);
});

test('CLI checkpoint replays lost output, acknowledges only its prior batch, and pages', async () => {
	for (let index = 0; index < 25; index++)
		await sendHuman(`message ${index}: ${'x'.repeat(1000)}`);
	const first = await fixture.run(['--checkpoint'], 'alpha');
	expect(first.code).toBe(0);
	const batch = JSON.parse(first.out) as Batch;
	const firstCount = batch.room?.events.length ?? 0;
	expect(firstCount).toBeGreaterThan(0);
	expect(firstCount).toBeLessThan(25);
	expect(batch.more).toBe(true);
	// A bare retry returns the SAME batch - that is the point of the replay - but it now says so.
	// It used to be byte-identical and therefore indistinguishable from a fresh read, which is how
	// Morgan spent 20 hours re-reading one batch: cursor frozen, nothing persisted, no signal.
	const bareRetry = JSON.parse((await fixture.run(['--checkpoint'], 'alpha')).out) as Batch;
	const { warning: bareWarning, ...bareBatch } = bareRetry;
	expect(bareBatch).toEqual(JSON.parse(first.out) as Batch);
	expect(bareWarning).toContain('already issued and is being replayed');
	const unread = JSON.parse(
		(await fixture.run(['--room', 'read'], 'alpha')).out,
	) as Batch['room'];
	expect(unread?.events[0]?.id).toBe(1);
	const second = JSON.parse(
		(await fixture.run(['--checkpoint', batch.receipt], 'alpha')).out,
	) as Batch;
	expect(second.room?.events).toHaveLength(25 - firstCount);
	expect(second.room?.events[0]?.id).toBe(firstCount + 1);
	expect(second.more).toBe(true);
	// Replaying the previous receipt cannot consume the second batch.
	const retry = JSON.parse(
		(await fixture.run(['--checkpoint', batch.receipt], 'alpha')).out,
	) as Batch;
	const { warning, ...replayedBatch } = retry;
	expect(replayedBatch).toEqual(second);
	expect(warning).toContain('Receipt already acknowledged');
	const invalid = await fixture.run(
		['--checkpoint', '11111111-1111-4111-8111-111111111111'],
		'alpha',
	);
	expect(invalid.code).toBe(1);
	expect(invalid.error).toContain('Unknown checkpoint receipt');
	const bareAfterInvalid = JSON.parse(
		(await fixture.run(['--checkpoint'], 'alpha')).out,
	) as Batch;
	const { warning: secondWarning, ...secondBatch } = bareAfterInvalid;
	expect(secondBatch).toEqual(second);
	expect(secondWarning).toContain('already issued and is being replayed');
	await sendHuman('halt');
	const final = JSON.parse(
		(await fixture.run(['--checkpoint', second.receipt], 'alpha')).out,
	) as Batch;
	expect(final.changed).toBe(false);
	expect(final.more).toBe(true);
	expect(unread?.events[0]?.id).toBe(1);
	const third = JSON.parse(
		(await fixture.run(['--checkpoint', final.receipt], 'alpha')).out,
	) as Batch;
	expect(third.paused).toBe(true);
	expect(third.room?.events[0]?.text).toBe('halt');
	expect((await fixture.run(['--checkpoint', batch.receipt], 'beta')).code).toBe(1);
});

test('an empty checkpoint cannot hide arrivals after a reader restarts', async () => {
	const empty = JSON.parse((await fixture.run(['--checkpoint'], 'alpha')).out) as Batch;
	expect(empty.changed).toBe(false);
	await sendHuman('arrived later');
	const fresh = JSON.parse((await fixture.run(['--checkpoint'], 'alpha')).out) as Batch;
	expect(fresh.room?.events[0]?.text).toBe('arrived later');
	await sendHuman('halt');
	const replay = JSON.parse((await fixture.run(['--checkpoint'], 'alpha')).out) as Batch;
	expect(replay.receipt).toBe(fresh.receipt);
	expect(replay.paused).toBe(true);
});

test('archiving mail preserves exact frozen recovery without consuming unresolved mail', async () => {
	const handled = await sendMessage('beta', 'alpha', 'Handled request');
	const unresolved = await sendMessage('beta', 'alpha', 'Unresolved request');
	const first = JSON.parse((await fixture.run(['--checkpoint'], 'alpha')).out) as Batch;
	expect(first.mail?.messages.map((message) => message.header.id)).toContain(handled);
	await fixture.run(['--mail', 'receive'], 'alpha');
	expect((await fixture.run(['--mail', 'ack-self', handled], 'alpha')).code).toBe(0);
	const replay = JSON.parse((await fixture.run(['--checkpoint'], 'alpha')).out) as Batch;
	expect(replay.receipt).toBe(first.receipt);
	expect(replay.mail).toEqual(first.mail);
	expect((await fixture.run(['--checkpoint'], 'alpha')).out).toContain(unresolved);
	const settled = JSON.parse(
		(await fixture.run(['--checkpoint', replay.receipt], 'alpha')).out,
	) as Batch;
	expect(settled.changed).toBe(false);
	expect(settled.more).toBe(true);
	expect(
		(JSON.parse((await fixture.run(['--checkpoint', settled.receipt], 'alpha')).out) as Batch)
			.more,
	).toBe(false);
	expect(
		await Bun.file(
			join(fixture.records, 'mailboxes', 'alpha', 'inbox', `${unresolved}.md`),
		).exists(),
	).toBe(true);
});

test('archiving the last cached mail preserves its receipt and permits later arrivals', async () => {
	const id = await sendMessage('beta', 'alpha', 'Handled request');
	const first = JSON.parse((await fixture.run(['--checkpoint'], 'alpha')).out) as Batch;
	await fixture.run(['--mail', 'receive'], 'alpha');
	expect((await fixture.run(['--mail', 'ack-self', id], 'alpha')).code).toBe(0);
	const replay = JSON.parse((await fixture.run(['--checkpoint'], 'alpha')).out) as Batch;
	expect(replay.receipt).toBe(first.receipt);
	expect(replay.changed).toBe(true);
	expect(replay.mail).toEqual(first.mail);
	const fresh = await sendMessage('beta', 'alpha', 'New arrival');
	const next = JSON.parse(
		(await fixture.run(['--checkpoint', replay.receipt], 'alpha')).out,
	) as Batch;
	expect(next.changed).toBe(false);
	const arrived = JSON.parse(
		(await fixture.run(['--checkpoint', next.receipt], 'alpha')).out,
	) as Batch;
	expect(arrived.mail?.messages[0]?.header.id).toBe(fresh);
});

test('fresh human traffic refreshes pending notices without replaying an unchanged wake', async () => {
	const notices: string[] = [];
	const send = (text: string): Promise<void> => {
		notices.push(text);
		return Promise.resolve();
	};
	await sendHuman('first');
	await notifyLocalRoom('alpha', 'burst', send);
	for (let index = 0; index < 30; index++) {
		await sendHuman(`burst ${index}`);
		await notifyLocalRoom('alpha', 'burst', send);
	}
	expect(notices).toHaveLength(31);
	// Compactness contract. It was 120 characters until notices began naming their causes with a
	// read command (addressed-post-wake-notices); the budget for the cause header plus instruction is
	// now WAKE_NOTICE_MAX, fitting five ids at full width. The optional backlog suffix is bounded
	// separately (addressed-post-wake-notices.test.ts).
	expect(notices[0]?.length).toBeLessThanOrEqual(WAKE_NOTICE_MAX);
	const notice = notices[0] ?? '';
	expect(notice).toContain('summon --current-requests');
	expect(notice.indexOf('summon --current-requests')).toBeLessThan(
		notice.indexOf('summon --checkpoint'),
	);
	await fixture.run(['--room', 'ack', '20'], 'alpha');
	await notifyLocalRoom('alpha', 'burst', send);
	expect(notices).toHaveLength(31);
	await fixture.run(['--room', 'ack', '31'], 'alpha');
	await notifyLocalRoom('alpha', 'burst', send);
	expect(notices).toHaveLength(31);
	// 31 rounds of locked notice I/O take about 2-3 s alone but can cross Bun's 5 s default under
	// full-suite load. The budget is a harness limit, not a product latency contract.
}, 20_000);

test('routine peers stay coalesced behind a pending wake; a new mention refreshes it', async () => {
	const notices: string[] = [];
	const send = (text: string): Promise<void> => {
		notices.push(text);
		return Promise.resolve();
	};
	await sendHuman('first');
	await notifyLocalRoom('alpha', 'peer-burst', send);
	for (let index = 0; index < 30; index++) {
		await appendLocalEvent({
			sender: { kind: 'agent', id: 'beta' },
			text: `routine ${index}`,
			replyTo: null,
			source: 'local',
		});
		await notifyLocalRoom('alpha', 'peer-burst', send);
	}
	expect(notices).toHaveLength(1);
	await appendLocalEvent({
		sender: { kind: 'agent', id: 'beta' },
		text: '@alpha please read',
		replyTo: null,
		source: 'local',
	});
	await notifyLocalRoom('alpha', 'peer-burst', send);
	expect(notices).toHaveLength(2);
	expect(notices[1]).toContain('through 32');
});

test('mechanical receipts stay durable without waking; substantive confirmations still wake', async () => {
	const notices: string[] = [];
	const stop = await startMailWatcher('alpha', 'receipt-test', (text) => {
		notices.push(text);
		return Promise.resolve();
	});
	try {
		for (let attempt = 0; !notices.length && attempt < 50; attempt++) await Bun.sleep(20);
		expect(notices).toHaveLength(1);
		const receipt = await sendMessage('beta', 'alpha', 'Read.', { kind: 'receipt' });
		await Bun.sleep(2200);
		expect(notices).toHaveLength(1);
		expect(
			await Bun.file(
				join(fixture.records, 'mailboxes', 'alpha', 'inbox', `${receipt}.md`),
			).exists(),
		).toBe(true);
		await sendMessage('beta', 'alpha', 'Cannot proceed; need clarification.', {
			kind: 'confirmation',
		});
		for (let attempt = 0; notices.length < 2 && attempt < 150; attempt++) await Bun.sleep(20);
		expect(notices).toHaveLength(2);
	} finally {
		await stop();
	}
});
