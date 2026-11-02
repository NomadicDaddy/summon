import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { initializeActivity, readActivity } from '../src/agent-activity.ts';
import { setCommunicationPause } from '../src/communication-state.ts';
import { stopTerminalReceivers, syncTerminalReceivers } from '../src/desktop/terminal-receivers.ts';
import {
	initializeKiloTurn,
	kiloStartupSettled,
	kiloStartupSubmitting,
	kiloTurn,
	observeKiloTurn,
} from '../src/kilo-turn-state.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { markReady, saveDelivery } from '../src/mail-session.ts';
import { pendingMessages, sendMessage } from '../src/mailbox.ts';
import { newRecord, updateAgentRecord } from '../src/store.ts';
import { wakeDeliveryStatus } from '../src/wake-delivery-store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { terminalHarness } from './fixtures/owned-terminal.ts';
import { waitForNotice } from './fixtures/wake-team.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let h: ReturnType<typeof terminalHarness>;
const oldHome = process.env.SUMMON_HOME;
const oldNonce = process.env.SUMMON_NONCE;
const nonce = 'coalescing-kilo';
const observer = 'owned-stream';
async function native(status: string): Promise<void> {
	await observeKiloTurn('alpha', nonce, observer, {
		type: 'session.status',
		properties: { sessionID: 'ses_exact', status: { type: status } },
	});
}
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
		thread: 'ses_exact',
		pid: process.pid,
		state: 'unconfirmed',
		reason: '',
	});
	await initializeKiloTurn('alpha', nonce, 'ses_exact', observer);
	await syncTerminalReceivers(h.team);
	// No notice before the startup turn completes (Phillip #22057): readiness follows its idle.
	await kiloStartupSubmitting('alpha', nonce, 'ses_exact');
	await kiloStartupSettled('alpha', nonce, 'ses_exact', 'accepted');
	await native('busy');
	await native('idle');
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

test('busy arrivals coalesce after native completion, preserving unread bodies and cursors', async () => {
	await sendMessage('beta', 'alpha', 'PRIVATE_ONE');
	await sendMessage('beta', 'alpha', 'PRIVATE_TWO');
	await Bun.sleep(2200);
	expect(h.inputs).toHaveLength(1);
	await native('busy');
	await native('idle');
	await waitForNotice(h.inputs, '2 new mailbox event');
	expect(h.inputs).toHaveLength(2);
	expect(h.inputs[1]).not.toContain('--mail ready');
	expect(h.inputs[1]).not.toContain('PRIVATE');
	expect(await pendingMessages('alpha')).toHaveLength(2);
	expect(await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists()).toBe(false);
	await sendMessage('beta', 'alpha', 'PRIVATE_THREE');
	await native('idle');
	await Bun.sleep(2200);
	expect(h.inputs).toHaveLength(2);
	await native('busy');
	await native('idle');
	await waitForNotice(h.inputs, '1 new mailbox event');
	expect(h.inputs).toHaveLength(3);
}, 15000);

test('manual Ready, human draft, Enter and halt do not replace native completion', async () => {
	await markReady('alpha', nonce);
	await sendMessage('beta', 'alpha', 'PRIVATE_DRAFT');
	await native('busy');
	await native('idle');
	await h.team.input('alpha', 'human draft');
	await Bun.sleep(2200);
	expect(h.inputs).toHaveLength(2);
	await h.team.input('alpha', '\r');
	await native('idle');
	await Bun.sleep(2200);
	expect(h.inputs).toHaveLength(3);
	await setCommunicationPause(true);
	try {
		await native('busy');
		await native('idle');
		await Bun.sleep(2200);
		expect(h.inputs).toHaveLength(3);
		expect(await pendingMessages('alpha')).toHaveLength(1);
	} finally {
		await setCommunicationPause(false);
	}
	await waitForNotice(h.inputs, '1 new mailbox event');
	expect(h.inputs).toHaveLength(4);
	expect(h.inputs[3]).not.toContain('human draft');
}, 15000);

test('pasted draft and future provider changes preserve the current native completion gate', async () => {
	await markReady('alpha', nonce);
	await native('busy');
	await sendMessage('beta', 'alpha', 'PRIVATE_KILO_CONTROL');
	await appendLocalEvent({
		sender: { kind: 'user', id: 'operator' },
		text: '@alpha work',
		replyTo: null,
		source: 'local',
	});
	await Bun.sleep(2200);
	expect(h.inputs).toHaveLength(1);
	await h.team.input('alpha', 'pasted human draft\r');
	const activity = await readActivity('alpha');
	await Bun.write(
		join(fixture.records, 'runtime/alpha/activity.json'),
		JSON.stringify({ ...activity, state: 'idle' }),
	);
	await native('idle');
	await Bun.sleep(2200);
	expect(h.inputs).toHaveLength(2);
	await updateAgentRecord('alpha', (record) => {
		record.provider = 'codex';
	});
	await h.team.input('alpha', '\r');
	await native('idle');
	await Bun.sleep(2200);
	expect(h.inputs).toHaveLength(3);
	await native('busy');
	await native('idle');
	await waitForNotice(h.inputs, 'mailbox event');
	expect(h.inputs).toHaveLength(4);
	expect(h.inputs[3]).toContain('summon room through 1');
	expect(h.inputs[3]).not.toContain('PRIVATE_KILO_CONTROL');
}, 15000);

test('uncertain write is reserved, and replacing only the receiver cannot replay it', async () => {
	await markReady('alpha', nonce);
	const session = h.team.sessions.get('alpha');
	if (!session) throw new Error('Missing terminal control.');
	let attempts = 0;
	session.pty.write = () => {
		attempts++;
		throw new Error('Unknown write outcome.');
	};
	await sendMessage('beta', 'alpha', 'uncertain body');
	await native('busy');
	await native('idle');
	await Bun.sleep(2400);
	expect(attempts).toBe(1);
	expect((await kiloTurn('alpha', nonce))?.phase).toBe('busy');
	expect(
		(await wakeDeliveryStatus('alpha', nonce)).unresolved.some(
			(item) => item.state === 'uncertain',
		),
	).toBe(true);
	await stopTerminalReceivers(h.team);
	await syncTerminalReceivers(h.team);
	await native('busy');
	await native('idle');
	await Bun.sleep(2200);
	expect(attempts).toBe(1);
	expect(await pendingMessages('alpha')).toHaveLength(1);
}, 15000);
