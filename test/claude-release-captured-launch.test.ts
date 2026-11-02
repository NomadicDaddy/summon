import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { setClaudeDelivery } from '../src/claude-delivery.ts';
import { claudeTurn, reserveClaudeNotice } from '../src/claude-turn-state.ts';
import { stopTerminalReceivers } from '../src/desktop/terminal-receivers.ts';
import { runtimePath } from '../src/mail-session.ts';
import { sendMessage } from '../src/mailbox.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { terminalHarness } from './fixtures/owned-terminal.ts';
import { attachFixtureReceiver } from './fixtures/wake-team.ts';

// Morticia's L-1 on 1.0.0 (467a524): a human line break spent the withheld-Enter token only when
// activity.json read cleanly, so with the file missing or briefly unreadable it was written without
// spending, and a later release could still free the seat. The pane's receiver now records the
// launch it captured, input spends for that launch, and only the current receiver may release.

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let h: ReturnType<typeof terminalHarness>;
let stop: (() => Promise<void>) | undefined;
const oldHome = process.env.SUMMON_HOME;
const oldNonce = process.env.SUMMON_NONCE;
const nonce = 'captured-claude';
const PASTE = '\u001b[200~';
const activityFile = () => join(runtimePath('alpha'), 'activity.json');

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_NONCE = nonce;
	await setClaudeDelivery('checkpoint');
	await Bun.write(
		join(fixture.records, 'alpha.json'),
		JSON.stringify(newRecord('alpha', fixture.root, 'claude')),
	);
	h = terminalHarness();
	await h.team.start('alpha', false);
	stop = await attachFixtureReceiver(h.team, 'alpha', nonce);
});
afterEach(async () => {
	await stop?.();
	stop = undefined;
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	if (oldNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = oldNonce;
	await fixture.dispose();
});

async function reserved(): Promise<string> {
	const { token } = await reserveClaudeNotice('alpha', nonce, true);
	if (!token) throw new Error('The terminal reserve should mint a token.');
	expect((await claudeTurn('alpha', nonce))?.release?.token).toBe(token);
	return token;
}

test('with activity.json missing, a human line break still spends the token first', async () => {
	await reserved();
	await rm(activityFile());
	await h.team.input('alpha', 'a\rb');
	expect((await claudeTurn('alpha', nonce))?.release).toBeUndefined();
	expect(h.inputs.at(-1)).toBe('a\rb');
}, 10000);

test('with activity.json briefly unreadable, the line break spends and is still written', async () => {
	await reserved();
	await Bun.write(activityFile(), '{ not json');
	await h.team.input('alpha', 'a\nb');
	expect((await claudeTurn('alpha', nonce))?.release).toBeUndefined();
	expect(h.inputs.at(-1)).toBe('a\nb');
}, 10000);

// Roger, 1ce6637: a standalone Enter takes the human-submit branch, which still read activity.json.
for (const [label, enter] of [
	['CR', '\r'],
	['LF', '\n'],
	['CRLF', '\r\n'],
] as const)
	for (const [state, spoil] of [
		['missing', () => rm(activityFile())],
		['unreadable', () => Bun.write(activityFile(), '{ not json')],
	] as const)
		test(`a standalone ${label} with activity.json ${state} records the submit and spends`, async () => {
			await reserved();
			await spoil();
			await h.team.input('alpha', enter);
			const state = await claudeTurn('alpha', nonce);
			expect(state?.release).toBeUndefined();
			expect(state).toMatchObject({ phase: 'busy', turn: null });
			expect(h.inputs.at(-1)).toBe(enter);
		}, 10000);

test('a receiver retired between paste and Enter never releases its reservation', async () => {
	await sendMessage('beta', 'alpha', 'PRIVATE_RETIRED');
	for (let attempt = 0; !h.inputs.some((input) => input.startsWith(PASTE)); attempt++) {
		if (attempt > 3000) throw new Error('The notice paste never arrived.');
		await Bun.sleep(1);
	}
	// Retiring the receivers inside the 100 ms pause makes its readiness check refuse the Enter.
	await stopTerminalReceivers(h.team);
	stop = undefined;
	await Bun.sleep(300);
	expect(h.inputs.filter((input) => input === '\r')).toHaveLength(0);
	const state = await claudeTurn('alpha', nonce);
	expect(state).toMatchObject({ phase: 'busy', turn: null });
	expect(state?.release).toBeDefined();
	expect(h.inputs.join('')).not.toContain('PRIVATE');
}, 15000);
