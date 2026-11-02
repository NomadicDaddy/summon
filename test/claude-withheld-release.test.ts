import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { setClaudeDelivery } from '../src/claude-delivery.ts';
import { claudeInputHold } from '../src/claude-notice-hold.ts';
import {
	claudeNoticeAllowed,
	claudeTurn,
	observeClaudeTurn,
	reserveClaudeNotice,
} from '../src/claude-turn-state.ts';
import { terminalDraft } from '../src/desktop/terminal-draft.ts';
import { deliveryView } from '../src/mail-session.ts';
import { sendMessage } from '../src/mailbox.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { terminalHarness } from './fixtures/owned-terminal.ts';
import { attachFixtureReceiver, waitForNotice } from './fixtures/wake-team.ts';

// Summon pastes a notice, then refuses to write its own Enter because human input arrived in the
// 100 ms before it. On e62d56c that left the record busy with no turn for good. Now that one
// reservation is released, the box is never touched, and the seat stays held only for as long as
// the pane input or Claude's own draft report says the box may hold text.

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let h: ReturnType<typeof terminalHarness>;
let stop: (() => Promise<void>) | undefined;
const oldHome = process.env.SUMMON_HOME;
const oldNonce = process.env.SUMMON_NONCE;
const nonce = 'withheld-claude';
const PASTE = '\u001b[200~';

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

async function native(kind: 'draft' | 'start' | 'complete', draft: boolean, turn?: string) {
	const state = await claudeTurn('alpha', nonce);
	if (!state) throw new Error('Missing fixture turn record.');
	await observeClaudeTurn('alpha', nonce, state.observer, {
		session: state.thread,
		epoch: state.epoch,
		sequence: state.sequence + 1,
		kind,
		turn: turn ?? null,
		draft,
		completed: kind === 'complete',
	});
}
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
	for (let attempt = 0; attempt < 600; attempt++) {
		if (await check()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${what}.`);
}

test('human input inside the Enter window releases the reservation, never the box', async () => {
	const pty = h.team.sessions.get('alpha')?.pty;
	if (!pty) throw new Error('Missing fixture terminal.');
	await sendMessage('beta', 'alpha', 'PRIVATE_WITHHELD');
	for (let attempt = 0; !h.inputs.some((input) => input.startsWith(PASTE)); attempt++) {
		if (attempt > 3000) throw new Error('The notice paste never arrived.');
		await Bun.sleep(1);
	}
	await h.team.input('alpha', 'x');
	await until(async () => (await claudeTurn('alpha', nonce))?.phase !== 'busy', 'the release');
	expect(await claudeTurn('alpha', nonce)).toMatchObject({
		phase: 'idle',
		turn: null,
		draft: true,
	});
	expect((await claudeTurn('alpha', nonce))?.release).toBeUndefined();
	expect(h.inputs.filter((input) => input === '\r')).toHaveLength(0);
	expect(h.inputs.join('')).not.toContain('PRIVATE');
	// No draft report has arrived, so the box may still hold text: the native gate stays shut.
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);

	await native('draft', true);
	await native('draft', false);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
	// The human's own input still holds the pane, and the status says so.
	expect(terminalDraft(pty).draft).toBe(true);
	await until(
		async () =>
			(await deliveryView('alpha')).reason.startsWith(claudeInputHold('alpha', nonce)),
		'the pane-input hold reason',
	);
	const before = h.inputs.length;
	await h.team.input('alpha', '\u0015');
	await sendMessage('beta', 'alpha', 'PRIVATE_NEXT');
	await until(
		() =>
			Promise.resolve(
				h.inputs.slice(before + 1).some((input) => input.startsWith(PASTE)) &&
					h.inputs.at(-1) === '\r',
			),
		'the next notice and its Enter',
	);
	expect(h.inputs.join('')).not.toContain('PRIVATE');
}, 25000);

test('a human chunk carrying a line break spends the token before it is written', async () => {
	const { token } = await reserveClaudeNotice('alpha', nonce, true);
	expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	expect((await claudeTurn('alpha', nonce))?.release?.token).toBe(token);
	await h.team.input('alpha', 'abc');
	expect((await claudeTurn('alpha', nonce))?.release?.token).toBe(token);
	await h.team.input('alpha', 'abc\rdef');
	expect((await claudeTurn('alpha', nonce))?.release).toBeUndefined();
	expect(h.inputs.at(-1)).toBe('abc\rdef');
}, 10000);

test('a native start after the paste keeps the seat busy for that turn, as before', async () => {
	await sendMessage('beta', 'alpha', 'PRIVATE_STARTED');
	await waitForNotice(h.inputs, 'mailbox event');
	await native('start', false, 'notice-turn');
	expect(await claudeTurn('alpha', nonce)).toMatchObject({ phase: 'busy', turn: 'notice-turn' });
	expect((await claudeTurn('alpha', nonce))?.release).toBeUndefined();
	await native('complete', false, 'notice-turn');
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
}, 15000);
