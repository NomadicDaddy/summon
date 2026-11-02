import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { Hold } from '../src/mail-attention.ts';
import type { ReceiverLease } from '../src/mail-session.ts';

import { checkpoint } from '../src/checkpoint.ts';
import { prepareLocalRoomNotice } from '../src/local-room-live.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { atomicWrite } from '../src/mail-files.ts';
import { acquireReceiver, markReady, saveDelivery } from '../src/mail-session.ts';
import { sendMessage } from '../src/mailbox.ts';
import { saveRoomWakePolicy } from '../src/room-wake-policy.ts';
import { newRecord } from '../src/store.ts';
import { prepareTelegramNotice } from '../src/telegram-live.ts';
import { recordRoomEvent } from '../src/telegram-room.ts';
import { createWakeCoordinator } from '../src/wake-coordinator.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let lease: ReceiverLease | undefined;
const originalFetch = globalThis.fetch;
const previous = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
};
const config = { botToken: '123:fixture', chatId: '456', allowedUserIds: ['456'] };
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = 'boundary-fixture';
	globalThis.fetch = Object.assign(
		() => Promise.resolve(Response.json({ ok: true, result: [] })),
		{ preconnect: originalFetch.preconnect },
	);
});
afterEach(async () => {
	await lease?.();
	lease = undefined;
	globalThis.fetch = originalFetch;
	if (previous.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous.home;
	if (previous.agent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previous.agent;
	if (previous.nonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = previous.nonce;
	await fixture.dispose();
});

async function post(
	text: string,
	kind: 'user' | 'agent' = 'user',
	replyTo: number | null = null,
	sender = 'beta',
) {
	return appendLocalEvent({ sender: { kind, id: sender }, text, replyTo, source: 'local' });
}

async function receiver(notices: string[]) {
	const nonce = process.env.SUMMON_NONCE ?? '';
	lease = await acquireReceiver('alpha', nonce);
	if (!lease) throw new Error('Fixture receiver lease missing.');
	const current = lease;
	await saveDelivery('alpha', {
		nonce,
		pid: process.pid,
		state: 'unconfirmed',
		reason: '',
		thread: 'fixture-thread',
	});
	await markReady('alpha', nonce);
	return createWakeCoordinator(
		'alpha',
		nonce,
		(text) => {
			notices.push(text);
			return Promise.resolve();
		},
		() => true,
		current.owns,
		{},
	);
}

test('mail, local room, Telegram and approval decisions share one bounded notice', async () => {
	await atomicWrite(join(fixture.records, 'integrations/telegram.json'), JSON.stringify(config));
	await sendMessage('alpha', 'alpha', 'PRIVATE_MAIL');
	await post('PRIVATE_ROOM');
	await recordRoomEvent(config, {
		messageId: 71,
		text: 'PRIVATE_TELEGRAM',
		sender: { kind: 'user', id: '456' },
		replyTo: null,
	});
	const hold: Hold = {
		id: randomUUID(),
		agent: 'alpha',
		messageId: randomUUID(),
		sender: 'beta',
		reason: 'PRIVATE_REASON',
		proposal: 'PRIVATE_PROPOSAL',
		digest: 'fixture',
		createdAt: new Date().toISOString(),
		decision: 'approve',
		userReference: 'Disposable control only',
	};
	await atomicWrite(
		join(fixture.records, 'mailboxes/alpha/holds', `${hold.id}.json`),
		JSON.stringify(hold),
	);
	const notices: string[] = [];
	const cycle = await receiver(notices);
	await cycle();
	await cycle();
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain('mailbox event');
	expect(notices[0]).toContain('summon room through 1');
	expect(notices[0]).toContain('summon Telegram through 1');
	expect(notices[0]).toContain('approval decision');
	expect(notices[0]).not.toContain('PRIVATE_');
	expect(await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists()).toBe(false);
});

// Package capture, receiver cycles and lease replacement share one bounded fixture budget.
test('active frozen pages suppress their covered work and later addressed arrivals remain actionable', async () => {
	const notices: string[] = [];
	const cycle = await receiver(notices);
	const id = await sendMessage('alpha', 'alpha', 'PRIVATE_LONG_BODY'.repeat(5000));
	await post('first request');
	const first = await checkpoint();
	expect(first.more).toBe(true);
	await cycle();
	expect(notices).toEqual([]);
	const next = await checkpoint(String(first.receipt));
	expect(next.more).toBe(true);
	await cycle();
	expect(notices).toEqual([]);
	await post('@alpha later work', 'agent');
	await cycle();
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain('through 2');
	expect(notices[0]).not.toContain('mailbox event');
	expect(
		await Bun.file(join(fixture.records, 'mailboxes/alpha/delivery', `${id}.read`)).exists(),
	).toBe(false);
	expect(await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists()).toBe(false);
	await lease?.();
	process.env.SUMMON_NONCE = 'replacement-boundary';
	const restarted: string[] = [];
	const nextCycle = await receiver(restarted);
	await nextCycle();
	expect(restarted).toHaveLength(1);
	expect(restarted[0]).toContain('mailbox event');
}, 15000);

test('routine peers and quoted mentions stay quiet; replies and configured recipients are positive controls', async () => {
	await post('routine peer traffic', 'agent');
	await post('> @alpha quoted\n`@alpha` "@alpha"', 'agent');
	expect(await prepareLocalRoomNotice('alpha', 'boundary-fixture')).toBeUndefined();
	await atomicWrite(
		join(fixture.records, 'steward.json'),
		JSON.stringify(newRecord('steward', fixture.root, 'codex')),
	);
	process.env.SUMMON_AGENT = '';
	await saveRoomWakePolicy(['steward']);
	expect((await prepareLocalRoomNotice('steward', 'steward-fixture'))?.target.through).toBe(2);
	process.env.SUMMON_AGENT = 'alpha';
	const own = await post('my question', 'agent', null, 'alpha');
	await post('unmentioned reply', 'agent', own.id);
	expect((await prepareLocalRoomNotice('alpha', 'boundary-fixture'))?.target.through).toBe(4);
	await atomicWrite(join(fixture.records, 'integrations/telegram.json'), JSON.stringify(config));
	await recordRoomEvent(config, {
		messageId: 1,
		text: '> @alpha quoted',
		sender: { kind: 'agent', id: 'beta' },
		replyTo: null,
	});
	expect(await prepareTelegramNotice('alpha', 'boundary-fixture')).toBeUndefined();
	process.env.SUMMON_AGENT = '';
	expect((await prepareTelegramNotice('steward', 'steward-fixture'))?.target.through).toBe(1);
});

test('replaced lease prevents input even with the same PID and launch nonce', async () => {
	const notices: string[] = [];
	const cycle = await receiver(notices);
	await post('positive control');
	await atomicWrite(
		join(fixture.records, 'runtime/alpha/receiver/owner.json'),
		JSON.stringify({ pid: process.pid, nonce: randomUUID(), launchNonce: 'boundary-fixture' }),
	);
	await cycle();
	expect(notices).toEqual([]);
	expect(
		await Bun.file(join(fixture.records, 'runtime/alpha/boundary-fixture.attempts')).exists(),
	).toBe(false);
});
