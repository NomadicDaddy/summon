import { afterEach, beforeEach, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity, readActivity } from '../src/agent-activity.ts';
import { setCommunicationPause } from '../src/communication-state.ts';
import { stopTerminalReceivers, syncTerminalReceivers } from '../src/desktop/terminal-receivers.ts';
import { grokTurn } from '../src/grok-turn-state.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { deliveryStatus, markReady, saveDelivery } from '../src/mail-session.ts';
import { pendingMessages, sendMessage } from '../src/mailbox.ts';
import { newRecord } from '../src/store.ts';
import { wakeDeliveryStatus } from '../src/wake-delivery-store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { terminalHarness } from './fixtures/owned-terminal.ts';
import { observeFixtureGrokIdle, waitForNotice } from './fixtures/wake-team.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let h: ReturnType<typeof terminalHarness>;
const oldHome = process.env.SUMMON_HOME;
const oldNonce = process.env.SUMMON_NONCE;
const nonce = 'coalescing-grok';
const thread = 'owned-native-grok';
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_NONCE = nonce;
	await writeFile(
		join(fixture.records, 'alpha.json'),
		JSON.stringify(newRecord('alpha', fixture.root, 'grok')),
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
	await syncTerminalReceivers(h.team);
	await waitForNotice(h.inputs, '--mail ready');
});
afterEach(async () => {
	await stopTerminalReceivers(h.team);
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	if (oldNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = oldNonce;
	await fixture.dispose();
});

test('busy arrivals cannot create multiple queued turns or repeat launch readiness', async () => {
	await sendMessage('beta', 'alpha', 'PRIVATE_FIRST');
	await sendMessage('beta', 'alpha', 'PRIVATE_SECOND');
	await appendLocalEvent({
		sender: { kind: 'user', id: 'operator' },
		text: '@alpha later work',
		replyTo: null,
		source: 'local',
	});
	await Bun.sleep(2200);
	expect(h.inputs).toHaveLength(1);
	expect((await grokTurn('alpha', nonce))?.phase).toBe('busy');
	await observeFixtureGrokIdle('alpha', nonce, thread);
	await waitForNotice(h.inputs, '2 new mailbox event');
	expect(h.inputs).toHaveLength(2);
	expect(h.inputs[1]).toContain('summon room through 1');
	expect(h.inputs[1]).not.toContain('--mail ready');
	expect(h.inputs[1]).not.toContain('PRIVATE_');
	expect(await pendingMessages('alpha')).toHaveLength(2);
	expect(await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists()).toBe(false);
	await sendMessage('beta', 'alpha', 'PRIVATE_THIRD');
	await Bun.sleep(2200);
	expect(h.inputs).toHaveLength(2);
	await markReady('alpha', nonce);
	await observeFixtureGrokIdle('alpha', nonce, thread);
	await waitForNotice(h.inputs, '1 new mailbox event');
	expect(h.inputs).toHaveLength(3);
}, 15000);

test('native holds report the current Grok launch and clear after observed idle', async () => {
	await markReady('alpha', nonce);
	await sendMessage('beta', 'alpha', 'PRIVATE_HELD_FOR_GROK');
	await Bun.sleep(2200);
	const held = await deliveryStatus('alpha', nonce);
	expect(held.state).toBe('queued-only');
	expect(held.reason).toContain(`Notices held for alpha launch ${nonce}:`);
	expect(held.reason).toContain('Grok');
	expect(held.reason).not.toContain('PRIVATE_');
	expect(h.inputs).toHaveLength(1);
	expect((await grokTurn('alpha', nonce))?.phase).toBe('busy');
	await observeFixtureGrokIdle('alpha', nonce, thread);
	await waitForNotice(h.inputs, '1 new mailbox event');
	await observeFixtureGrokIdle('alpha', nonce, thread);
	await Bun.sleep(2200);
	expect((await deliveryStatus('alpha', nonce)).reason).not.toContain('Notices held');
	expect((await grokTurn('alpha', nonce))?.phase).toBe('idle');
}, 15000);

test('native idle does not submit a human draft, and manual Ready cannot release a busy turn', async () => {
	await markReady('alpha', nonce);
	await sendMessage('beta', 'alpha', 'PRIVATE_DRAFT');
	const activity = await readActivity('alpha');
	await writeFile(
		join(fixture.records, 'runtime/alpha/activity.json'),
		JSON.stringify({ ...activity, state: 'idle' }),
	);
	await Bun.sleep(2200);
	expect(h.inputs).toHaveLength(1);
	await h.team.input('alpha', 'human draft');
	await observeFixtureGrokIdle('alpha', nonce, thread);
	await Bun.sleep(2200);
	expect(h.inputs).toEqual([h.inputs[0] ?? '', 'human draft']);
	await h.team.input('alpha', '\r');
	await Bun.sleep(2200);
	expect(h.inputs).toHaveLength(3);
	await observeFixtureGrokIdle('alpha', nonce, thread);
	await waitForNotice(h.inputs, '1 new mailbox event');
	expect(h.inputs).toHaveLength(4);
	expect(h.inputs[3]).not.toContain('human draft');
}, 15000);

test('receiver replacement does not forget the outstanding turn reservation', async () => {
	await stopTerminalReceivers(h.team);
	await syncTerminalReceivers(h.team);
	await sendMessage('beta', 'alpha', 'retained later work');
	await Bun.sleep(2200);
	expect(h.inputs).toHaveLength(1);
	await markReady('alpha', nonce);
	await observeFixtureGrokIdle('alpha', nonce, thread);
	await waitForNotice(h.inputs, '1 new mailbox event');
	expect(h.inputs).toHaveLength(2);
}, 15000);

test('verified idle still waits through a communication halt without consuming mail', async () => {
	await markReady('alpha', nonce);
	await sendMessage('beta', 'alpha', 'held work');
	await setCommunicationPause(true);
	try {
		await observeFixtureGrokIdle('alpha', nonce, thread);
		await Bun.sleep(2200);
		expect(h.inputs).toHaveLength(1);
		expect(await pendingMessages('alpha')).toHaveLength(1);
	} finally {
		await setCommunicationPause(false);
	}
	await waitForNotice(h.inputs, '1 new mailbox event');
	expect(h.inputs).toHaveLength(2);
}, 15000);

test('uncertain terminal write retains its reservation and never replays the same source', async () => {
	await markReady('alpha', nonce);
	const session = h.team.sessions.get('alpha');
	if (!session) throw new Error('Missing terminal control.');
	const write = session.pty.write;
	let attempts = 0;
	session.pty.write = () => {
		attempts += 1;
		throw new Error('Unknown terminal write outcome.');
	};
	await sendMessage('beta', 'alpha', 'uncertain work');
	await observeFixtureGrokIdle('alpha', nonce, thread);
	await Bun.sleep(2400);
	expect(attempts).toBe(1);
	expect((await grokTurn('alpha', nonce))?.phase).toBe('busy');
	expect(
		(await wakeDeliveryStatus('alpha', nonce)).unresolved.some(
			(value) => value.state === 'uncertain',
		),
	).toBe(true);
	session.pty.write = write;
	await observeFixtureGrokIdle('alpha', nonce, thread);
	await Bun.sleep(2200);
	expect(h.inputs).toHaveLength(1);
	expect(await pendingMessages('alpha')).toHaveLength(1);
}, 15000);
