import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { startClaudeChannel } from '../src/claude-channel-delivery.ts';
import { claudeTurn, initializeClaudeTurn, observeClaudeTurn } from '../src/claude-turn-state.ts';
import { stopTerminalReceivers, syncTerminalReceivers } from '../src/desktop/terminal-receivers.ts';
import { markReady, saveDelivery } from '../src/mail-session.ts';
import { pendingMessages, sendMessage } from '../src/mailbox.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { terminalHarness } from './fixtures/owned-terminal.ts';
import { waitForNotice } from './fixtures/wake-team.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let stopChannel: (() => Promise<void>) | undefined;
let h: ReturnType<typeof terminalHarness>;
const oldHome = process.env.SUMMON_HOME;
const oldNonce = process.env.SUMMON_NONCE;
const nonce = 'coalescing-claude';
let sequence = 0;
async function native(
	kind: 'attach' | 'start' | 'complete' | 'draft',
	turn: string | null = null,
	draft = false,
): Promise<void> {
	await observeClaudeTurn('alpha', nonce, 'owned-observer', {
		session: 'exact-thread',
		epoch: 1,
		sequence: ++sequence,
		kind,
		turn,
		draft,
		completed: kind === 'complete',
	});
}
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_NONCE = nonce;
	sequence = 0;
	await mkdir(join(fixture.records, 'settings'), { recursive: true });
	await Bun.write(
		join(fixture.records, 'settings/claude-delivery.json'),
		JSON.stringify({ version: 1, mode: 'checkpoint' }),
	);
	h = terminalHarness();
	await h.team.start('alpha', false);
	await initializeActivity('alpha', nonce);
	await saveDelivery('alpha', {
		nonce,
		thread: 'exact-thread',
		pid: process.pid,
		state: 'unconfirmed',
		reason: '',
	});
	await initializeClaudeTurn('alpha', nonce, 'exact-thread', 'owned-observer');
	await native('attach');
});
afterEach(async () => {
	await stopChannel?.();
	stopChannel = undefined;
	await stopTerminalReceivers(h.team);
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	if (oldNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = oldNonce;
	await fixture.dispose();
});

test('owned terminal coalesces busy arrivals; draft and old completion cannot submit', async () => {
	await native('start', 'positional-startup');
	await syncTerminalReceivers(h.team);
	await Bun.sleep(2200);
	expect(h.inputs).toHaveLength(0);
	await native('complete', 'positional-startup');
	await waitForNotice(h.inputs, '--mail ready');
	await markReady('alpha', nonce);
	await native('start', 'bootstrap');
	await sendMessage('beta', 'alpha', 'PRIVATE_ONE');
	await sendMessage('beta', 'alpha', 'PRIVATE_TWO');
	await Bun.sleep(2200);
	expect(h.inputs).toHaveLength(2); // One paste and its distinct Enter.
	await native('complete', 'bootstrap');
	await waitForNotice(h.inputs, '2 new mailbox event');
	await Bun.sleep(150);
	expect(h.inputs).toHaveLength(4);
	expect(h.inputs[2]).not.toContain('PRIVATE');
	expect(await pendingMessages('alpha')).toHaveLength(2);
	await sendMessage('beta', 'alpha', 'PRIVATE_THREE');
	await native('complete', 'bootstrap');
	await h.team.input('alpha', 'human draft');
	await native('start', 'next', true);
	await native('complete', 'next', true);
	await Bun.sleep(2200);
	expect(h.inputs).toHaveLength(5);
	await h.team.input('alpha', '\r');
	await native('complete', 'next');
	await Bun.sleep(2200);
	expect(h.inputs).toHaveLength(6);
	await native('start', 'human');
	await native('complete', 'human');
	await waitForNotice(h.inputs, '1 new mailbox event');
	await Bun.sleep(150);
	expect(h.inputs).toHaveLength(8);
}, 20000);

test('MCP channel reserves before send and awaits native completion rather than manual Ready', async () => {
	const sent: string[] = [];
	await native('start', 'positional-startup');
	stopChannel = await startClaudeChannel('alpha', nonce, async (text) => {
		expect((await claudeTurn('alpha', nonce))?.phase).toBe('busy');
		sent.push(text);
	});
	await Bun.sleep(2200);
	expect(sent).toHaveLength(0);
	await native('complete', 'positional-startup');
	await waitForNotice(sent, '--mail ready');
	await markReady('alpha', nonce);
	await sendMessage('beta', 'alpha', 'PRIVATE_ONE');
	await sendMessage('beta', 'alpha', 'PRIVATE_TWO');
	await Bun.sleep(2200);
	expect(sent).toHaveLength(1);
	await native('start', 'one');
	await native('complete', 'one');
	await waitForNotice(sent, '2 new mailbox event');
	expect(sent).toHaveLength(2);
	expect(sent[1]).not.toContain('PRIVATE');
	await sendMessage('beta', 'alpha', 'PRIVATE_THREE');
	await native('complete', 'one');
	await Bun.sleep(2200);
	expect(sent).toHaveLength(2);
}, 15000);

test('uncertain MCP send retains reservation and receiver replacement cannot replay', async () => {
	await markReady('alpha', nonce);
	let attempts = 0;
	stopChannel = await startClaudeChannel('alpha', nonce, () => {
		attempts++;
		throw new Error('Unknown channel write outcome');
	});
	await sendMessage('beta', 'alpha', 'PRIVATE_UNCERTAIN');
	await native('start', 'one');
	await native('complete', 'one');
	await Bun.sleep(2400);
	expect(attempts).toBe(1);
	expect((await claudeTurn('alpha', nonce))?.phase).toBe('busy');
	await stopChannel();
	stopChannel = await startClaudeChannel('alpha', nonce, () => {
		attempts++;
		return Promise.resolve();
	});
	await native('start', 'two');
	await native('complete', 'two');
	await Bun.sleep(2200);
	expect(attempts).toBe(1);
	expect(await pendingMessages('alpha')).toHaveLength(1);
}, 15000);
