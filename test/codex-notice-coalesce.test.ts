import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { Hold } from '../src/mail-attention.ts';

import { checkpoint } from '../src/checkpoint.ts';
import { atomicWrite, optionalText } from '../src/mail-files.ts';
import { NotificationNotSentError } from '../src/notification-delivery.ts';
import { localCursorPath } from '../src/room-cursor.ts';
import {
	coalesceReceiver,
	operatorPost,
	readRoomThrough,
	releaseFixtureReceiver,
} from './fixtures/coalesce-receiver.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

// #24276, Room source. Auden's export measured five Room notices submitted 22:15-22:29Z whose
// matching input records appear 22:36-22:40Z; turn boundaries and mail pairing were not measured.

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const saved = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
	quiet: process.env.SUMMON_ROOM_WAKE_QUIET_MS,
};
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = 'room-launch';
	process.env.SUMMON_ROOM_WAKE_QUIET_MS = '0';
});
afterEach(async () => {
	await releaseFixtureReceiver();
	if (saved.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = saved.home;
	if (saved.agent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = saved.agent;
	if (saved.nonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = saved.nonce;
	if (saved.quiet === undefined) delete process.env.SUMMON_ROOM_WAKE_QUIET_MS;
	else process.env.SUMMON_ROOM_WAKE_QUIET_MS = saved.quiet;
	await fixture.dispose();
});
const on = { coalesceQueuedNotices: true };
const cursor = () => optionalText(localCursorPath('alpha'));

test('a queued Room notice holds the next until the cursor reaches it; later posts then follow', async () => {
	const { cycle, sent } = await coalesceReceiver('room-launch', on);
	const first = await operatorPost('First.');
	await cycle();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toStartWith(`summon room through ${first.id} (read cursor)`);
	const later = await operatorPost('Later, while the first is still queued.');
	await cycle();
	expect(sent).toHaveLength(1);
	await readRoomThrough(first.id);
	await cycle();
	expect(sent).toHaveLength(2);
	expect(sent[1]).toStartWith(
		`summon room through ${later.id} (read cursor); for you: #${later.id}`,
	);
});

test('the active checkpoint package releases the hold without writing a read cursor', async () => {
	const { cycle, sent } = await coalesceReceiver('room-launch', on);
	await operatorPost('First.');
	await cycle();
	await operatorPost('Inside the package.');
	// Held first, so the release below is the package's doing, not the absence of a hold.
	await cycle();
	expect(sent).toHaveLength(1);
	await checkpoint();
	await cycle();
	// Covered by the package: released, and nothing new outside it to announce.
	expect(sent).toHaveLength(1);
	expect(await cursor()).toBeUndefined();
	const outside = await operatorPost('After the package was frozen.');
	await cycle();
	expect(sent).toHaveLength(2);
	expect(sent[1]).toStartWith(`summon room through ${outside.id} (read cursor)`);
});

test('without the option every new Room batch is submitted, as today', async () => {
	const { cycle, sent } = await coalesceReceiver('room-launch', {});
	await operatorPost('First.');
	await cycle();
	const later = await operatorPost('Later.');
	await cycle();
	expect(sent).toHaveLength(2);
	expect(sent[1]).toStartWith(`summon room through ${later.id} (read cursor)`);
});

test('an uncertain Room submission does not hold, and is not replayed', async () => {
	let failOnce = true;
	const { cycle, sent } = await coalesceReceiver('room-launch', on, {
		fail: () => {
			if (!failOnce) return undefined;
			failOnce = false;
			return new Error('provider closed mid-write');
		},
	});
	const first = await operatorPost('First.');
	await cycle();
	expect(sent).toHaveLength(0);
	const later = await operatorPost('Later.');
	await cycle();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toStartWith(
		`summon room through ${later.id} (read cursor); for you: #${later.id}`,
	);
	expect(sent[0]).not.toContain(`#${first.id}`);
});

test('a definitely unsent Room notice does not hold; its posts ride the next attempt', async () => {
	let failOnce = true;
	const { cycle, sent } = await coalesceReceiver('room-launch', on, {
		fail: () => {
			if (!failOnce) return undefined;
			failOnce = false;
			return new NotificationNotSentError('terminal unavailable');
		},
	});
	const first = await operatorPost('First.');
	await cycle();
	expect(sent).toHaveLength(0);
	const later = await operatorPost('Later.');
	await cycle();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain(`#${first.id} #${later.id}`);
});

test('a queued notice of one launch does not hold another launch', async () => {
	const first = await coalesceReceiver('room-launch', on);
	await operatorPost('First.');
	await first.cycle();
	expect(first.sent).toHaveLength(1);
	process.env.SUMMON_NONCE = 'room-launch-two';
	const second = await coalesceReceiver('room-launch-two', on);
	const later = await operatorPost('Later.');
	await second.cycle();
	expect(second.sent).toHaveLength(1);
	expect(second.sent[0]).toContain(`summon room through ${later.id}`);
});

test('approval decisions are still announced while the Room source is held', async () => {
	const { cycle, sent } = await coalesceReceiver('room-launch', on);
	await operatorPost('First.');
	await cycle();
	await operatorPost('Held.');
	const hold: Hold = {
		id: randomUUID(),
		agent: 'alpha',
		messageId: randomUUID(),
		sender: 'beta',
		reason: 'Fixture reason',
		proposal: 'Fixture proposal',
		digest: 'fixture',
		createdAt: new Date().toISOString(),
		decision: 'approve',
		userReference: 'Disposable control only',
	};
	await atomicWrite(
		join(fixture.records, 'mailboxes/alpha/holds', `${hold.id}.json`),
		JSON.stringify(hold),
	);
	await cycle();
	expect(sent).toHaveLength(2);
	expect(sent[1]).toContain('approval decision');
	expect(sent[1]).not.toContain('summon room through');
});

test('readiness: the first notice is unchanged; its reminder waits when held Room is the only source', async () => {
	const { cycle, sent } = await coalesceReceiver('room-launch', on, { ready: false });
	const first = await operatorPost('First.');
	await cycle();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain('summon mailbox readiness');
	expect(sent[0]).toContain(`summon room through ${first.id}`);
	// The reminder rides only on a natural notice, and the held Room batch is not one (disclosed).
	// Any other source's part in the cycle, such as mail or an approval decision, would carry it.
	await operatorPost('Held.');
	await cycle();
	expect(sent).toHaveLength(1);
});
