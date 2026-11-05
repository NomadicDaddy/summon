import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { stopTerminalReceivers, syncTerminalReceivers } from '../src/desktop/terminal-receivers.ts';
import {
	initializeKiloTurn,
	invalidateKiloTurn,
	kiloStartupSettled,
	kiloStartupSubmitting,
	kiloTurn,
	observeKiloTurn,
} from '../src/kilo-turn-state.ts';
import { startKiloTurnStream } from '../src/kilo-turn-stream.ts';
import { deliveryView, noticesHeldPrefix, saveDelivery } from '../src/mail-session.ts';
import { sendMessage } from '../src/mailbox.ts';
import { RECEIVER_FALLBACK_MS } from '../src/receiver-cadence.ts';
import { newRecord } from '../src/store.ts';
import { createWakeCoordinator } from '../src/wake-coordinator.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { terminalHarness } from './fixtures/owned-terminal.ts';
import { waitForNotice } from './fixtures/wake-team.ts';

// Roger M1 and Morticia L1 on 8a3ffce: a Kilo seat whose notices are held says why in its delivery
// status, from observed state only. An ordinary startup wait or a busy turn says nothing.

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let h: ReturnType<typeof terminalHarness>;
const oldHome = process.env.SUMMON_HOME;
const oldNonce = process.env.SUMMON_NONCE;
const nonce = 'held-kilo';
const thread = 'ses_exact';
const prefix = `${noticesHeldPrefix}alpha launch ${nonce}:`;
const deliveryPath = () => join(fixture.records, 'runtime/alpha', `${nonce}.json`);

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_NONCE = nonce;
	await Bun.write(
		join(fixture.records, 'alpha.json'),
		JSON.stringify(newRecord('alpha', fixture.root, 'kilo')),
	);
	h = terminalHarness();
	await h.team.start('alpha', false);
	await initializeActivity('alpha', nonce);
	await saveDelivery('alpha', {
		nonce,
		thread,
		pid: process.pid,
		state: 'unconfirmed',
		reason: '',
	});
});
afterEach(async () => {
	await stopTerminalReceivers(h.team);
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	if (oldNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = oldNonce;
	await fixture.dispose();
});

const native = (status: string, observer = 'stream-one') =>
	observeKiloTurn('alpha', nonce, observer, {
		type: 'session.status',
		properties: { sessionID: thread, status: { type: status } },
	});
const held = (text: string) => (reason: string) =>
	reason.startsWith(prefix) && reason.includes(text);
const notHeld = (reason: string) => !reason.startsWith(noticesHeldPrefix);
async function waitForStatus(match: (reason: string) => boolean): Promise<string> {
	for (let attempt = 0; attempt < 500; attempt++) {
		const { reason } = await deliveryView('alpha');
		if (match(reason)) return reason;
		await Bun.sleep(10);
	}
	throw new Error(`Delivery status did not settle: ${(await deliveryView('alpha')).reason}`);
}
/** One full fallback interval checks the held state again; the pump test covers repeated cadence. */
const oneFallback = () => Bun.sleep(RECEIVER_FALLBACK_MS + 300);

async function startedSeat(): Promise<void> {
	await initializeKiloTurn('alpha', nonce, thread, 'stream-one');
	await syncTerminalReceivers(h.team);
	await kiloStartupSubmitting('alpha', nonce, thread);
	await kiloStartupSettled('alpha', nonce, thread, 'accepted');
	await native('busy');
	await native('idle');
	await waitForNotice(h.inputs, '--mail ready');
}

test('no attached stream: held with its reason and no input, even before startup settles', async () => {
	// The receiver creates the record with no observer; no stream ever attaches.
	await syncTerminalReceivers(h.team);
	await sendMessage('beta', 'alpha', 'PRIVATE_HELD');
	const reason = await waitForStatus(held('no Kilo turn stream is attached'));
	expect(reason).toContain(
		'summon --checkpoint collects queued work but does not restore observation; only an operator relaunch does.',
	);
	expect(reason).not.toContain('PRIVATE');
	expect((await deliveryView('alpha')).state).toBe('queued-only');
	await kiloStartupSubmitting('alpha', nonce, thread);
	await oneFallback();
	expect(held('no Kilo turn stream is attached')((await deliveryView('alpha')).reason)).toBe(
		true,
	);
	expect(h.inputs).toHaveLength(0);
}, 30000);

test('the immediate consumer, summon --mail status, reports the held reason', async () => {
	await syncTerminalReceivers(h.team);
	await waitForStatus(held('no Kilo turn stream is attached'));
	const result = await fixture.run(['--mail', 'status'], 'alpha', { SUMMON_NONCE: nonce });
	expect(result.code).toBe(0);
	const status = JSON.parse(result.out) as { state: string; reason: string };
	expect(status.state).toBe('queued-only');
	expect(held('no Kilo turn stream is attached')(status.reason)).toBe(true);
}, 15000);

test('a missing record is held with its reason', async () => {
	await startedSeat();
	await rm(join(fixture.records, 'runtime/alpha', `${nonce}.kilo-turn`));
	await sendMessage('beta', 'alpha', 'PRIVATE_MISSING');
	await waitForStatus(held('no Kilo turn record'));
	expect(h.inputs).toHaveLength(1);
}, 15000);

test('lost after an accepted startup, then reattached: lost, waiting, busy clears, idle delivers', async () => {
	await startedSeat();
	await invalidateKiloTurn('alpha', nonce, 'stream-one');
	await sendMessage('beta', 'alpha', 'PRIVATE_LOST');
	await waitForStatus(held('no Kilo turn stream is attached'));
	// Late events from the lost observer cannot complete a turn.
	await native('busy');
	await native('idle');
	expect((await kiloTurn('alpha', nonce))?.observer).toBeNull();
	expect((await kiloTurn('alpha', nonce))?.phase).toBe('unknown');
	await initializeKiloTurn('alpha', nonce, thread, 'stream-two');
	await waitForStatus(
		held('waiting for an observed busy then idle on its Kilo turn stream (startup accepted)'),
	);
	expect(h.inputs).toHaveLength(1);
	await native('busy', 'stream-two');
	await waitForStatus(notHeld);
	expect(h.inputs).toHaveLength(1);
	await native('idle', 'stream-two');
	await waitForNotice(h.inputs, '1 new mailbox event');
	expect(h.inputs[1]).not.toContain('PRIVATE');
	await waitForStatus(notHeld);
}, 20000);

test('an uncertain startup with no events is held as waiting', async () => {
	await initializeKiloTurn('alpha', nonce, thread, 'stream-one');
	await syncTerminalReceivers(h.team);
	await kiloStartupSubmitting('alpha', nonce, thread);
	await kiloStartupSettled('alpha', nonce, thread, 'uncertain');
	await sendMessage('beta', 'alpha', 'PRIVATE_UNCERTAIN');
	await waitForStatus(held('(startup uncertain)'));
	expect(h.inputs).toHaveLength(0);
}, 15000);

test('an attached stream waiting on startup, and a busy turn, write no hold', async () => {
	await initializeKiloTurn('alpha', nonce, thread, 'stream-one');
	await syncTerminalReceivers(h.team);
	await sendMessage('beta', 'alpha', 'PRIVATE_QUIET');
	await oneFallback();
	expect(notHeld((await deliveryView('alpha')).reason)).toBe(true);
	await kiloStartupSubmitting('alpha', nonce, thread);
	await native('busy');
	await kiloStartupSettled('alpha', nonce, thread, 'accepted');
	await oneFallback();
	expect(notHeld((await deliveryView('alpha')).reason)).toBe(true);
	expect(h.inputs).toHaveLength(0);
	await native('idle');
	await waitForNotice(h.inputs, '--mail ready');
}, 50000);

test('a hold is written only on change, and a human draft leaves the status alone', async () => {
	await syncTerminalReceivers(h.team);
	await waitForStatus(held('no Kilo turn stream is attached'));
	const written = (await stat(deliveryPath())).mtimeMs;
	await oneFallback();
	expect((await stat(deliveryPath())).mtimeMs).toBe(written);
	await h.team.input('alpha', 'human draft');
	// Attached and waiting on startup would clear the hold, but a draft means no one may say so.
	await initializeKiloTurn('alpha', nonce, thread, 'stream-one');
	await oneFallback();
	expect(held('no Kilo turn stream is attached')((await deliveryView('alpha')).reason)).toBe(
		true,
	);
}, 50000);

test('a replacement launch starts with its own status, not the old hold', async () => {
	await syncTerminalReceivers(h.team);
	await waitForStatus(held('no Kilo turn stream is attached'));
	const next = 'held-kilo-two';
	process.env.SUMMON_NONCE = next;
	await initializeActivity('alpha', next);
	await saveDelivery('alpha', {
		nonce: next,
		thread,
		pid: process.pid,
		state: 'unconfirmed',
		reason: '',
	});
	await initializeKiloTurn('alpha', next, thread, 'stream-next');
	await syncTerminalReceivers(h.team);
	await oneFallback();
	expect(notHeld((await deliveryView('alpha')).reason)).toBe(true);
	expect(h.inputs).toHaveLength(0);
}, 30000);

test('the final save keeps a hold that is still current', async () => {
	await saveDelivery('alpha', {
		nonce,
		thread,
		pid: process.pid,
		state: 'live',
		reason: 'earlier',
	});
	const reason = `${prefix} fixture hold.`;
	const tick = createWakeCoordinator(
		'alpha',
		nonce,
		async () => {},
		() => true,
		() => Promise.resolve(true),
		{ noticeAllowed: () => Promise.resolve(true), noticeHold: () => Promise.resolve(reason) },
	);
	await tick();
	const status = await deliveryView('alpha');
	expect(status.state).toBe('queued-only');
	expect(status.reason).toBe(reason);
});

test('a failed subscription leaves no observer, and only the lost observer is cleared', async () => {
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response('PRIVATE_RESPONSE', { status: 401 }),
	});
	try {
		const error: unknown = await startKiloTurnStream(
			new URL('event', server.url).href,
			{},
			AbortSignal.timeout(1000),
			{ name: 'alpha', nonce },
			thread,
		).catch((value: unknown) => value);
		expect(String(error)).toContain('unavailable');
	} finally {
		await server.stop(true);
	}
	expect((await kiloTurn('alpha', nonce))?.observer).toBeNull();
	// A replacement observer survives a late invalidation of the one it replaced.
	await initializeKiloTurn('alpha', nonce, thread, 'stream-two');
	await invalidateKiloTurn('alpha', nonce, 'stream-one');
	expect((await kiloTurn('alpha', nonce))?.observer).toBe('stream-two');
	await kiloStartupSubmitting('alpha', nonce, thread);
	await native('busy');
	expect((await kiloTurn('alpha', nonce))?.phase).toBe('unknown');
	await native('busy', 'stream-two');
	expect((await kiloTurn('alpha', nonce))?.phase).toBe('busy');
});
