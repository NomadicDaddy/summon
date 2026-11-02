import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { join } from 'node:path';

import { setClaudeDelivery } from '../src/claude-delivery.ts';
import { claudeNoticeAllowed, claudeTurn, observeClaudeTurn } from '../src/claude-turn-state.ts';
import { claudeNoticeSender, recordClaudeInput } from '../src/desktop/claude-terminal-input.ts';
import { terminalDraft } from '../src/desktop/terminal-draft.ts';
import { sendMessage } from '../src/mailbox.ts';
import { newRecord } from '../src/store.ts';
import { loadWakeOutcome, wakeDeliveryStatus } from '../src/wake-delivery-store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

// Keep the production sender and receiver. Replace only the sender's 100 ms timer with a
// deterministic barrier so native reports and readiness changes finish before the Enter check.
const productionSender = claudeNoticeSender;
const productionInput = recordClaudeInput;
let pasteWait: Promise<void>;
let finishPaste: () => void = () => {};
await mock.module('../src/desktop/claude-terminal-input.ts', () => ({
	claudeNoticeSender: (pty: Parameters<typeof productionSender>[0], ready: () => Promise<void>) =>
		productionSender(pty, ready, () => pasteWait),
	recordClaudeInput: productionInput,
}));
const { terminalHarness } = await import('./fixtures/owned-terminal.ts');
const { attachFixtureReceiver } = await import('./fixtures/wake-team.ts');
let fixture: Awaited<ReturnType<typeof mailHarness>>;
let h: ReturnType<typeof terminalHarness>;
let stop: (() => Promise<void>) | undefined;
const oldHome = process.env.SUMMON_HOME;
const oldNonce = process.env.SUMMON_NONCE;
const nonce = 'withheld-readiness';
const PASTE = '\u001b[200~';

beforeEach(async () => {
	pasteWait = new Promise<void>((resolve) => {
		finishPaste = resolve;
	});
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
	finishPaste();
	await stop?.();
	stop = undefined;
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	if (oldNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = oldNonce;
	await fixture.dispose();
});
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
	for (let attempt = 0; attempt < 600; attempt++) {
		if (await check()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${what}.`);
}
async function nativeDraft(draft: boolean): Promise<void> {
	const state = await claudeTurn('alpha', nonce);
	if (!state) throw new Error('Missing fixture turn.');
	await observeClaudeTurn('alpha', nonce, state.observer, {
		session: state.thread,
		epoch: state.epoch,
		sequence: state.sequence + 1,
		kind: 'draft',
		turn: null,
		draft,
		completed: false,
	});
}

test('readiness refusal clears only the proved empty own mark and permits new work without retry', async () => {
	const session = h.team.sessions.get('alpha');
	if (!session) throw new Error('Missing fixture terminal.');
	await sendMessage('beta', 'alpha', 'PRIVATE_FIRST');
	await until(() => Promise.resolve(h.inputs.some((input) => input.startsWith(PASTE))), 'paste');
	session.stopRequested = true;
	await nativeDraft(true);
	await nativeDraft(false);
	finishPaste();
	await until(
		async () => (await wakeDeliveryStatus('alpha', nonce)).latest?.state === 'uncertain',
		'uncertain outcome',
	);
	const first = (await wakeDeliveryStatus('alpha', nonce)).latest;
	if (!first) throw new Error('Missing original outcome.');
	expect(first.failure?.category).toBe('send-uncertain');
	expect(await loadWakeOutcome('alpha', nonce, first.id)).toMatchObject({
		state: 'uncertain',
		attempts: 1,
		retryAt: 0,
	});
	expect(await claudeTurn('alpha', nonce)).toMatchObject({
		phase: 'idle',
		turn: null,
		draft: false,
	});
	expect(terminalDraft(session.pty)).toMatchObject({ version: 0, draft: false });
	expect(h.inputs.filter((input) => input === '\r')).toHaveLength(0);
	expect(h.inputs.filter((input) => input.startsWith(PASTE))).toHaveLength(1);
	session.stopRequested = false;
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
	await sendMessage('beta', 'alpha', 'PRIVATE_NEW');
	await until(
		() =>
			Promise.resolve(
				h.inputs.filter((input) => input.startsWith(PASTE)).length === 2 &&
					h.inputs.at(-1) === '\r',
			),
		'new work',
	);
	expect(await loadWakeOutcome('alpha', nonce, first.id)).toMatchObject({
		state: 'uncertain',
		attempts: 1,
		retryAt: 0,
	});
	expect(h.inputs.join('')).not.toContain('PRIVATE');
}, 20000);

test('current native text keeps both holds after a readiness refusal', async () => {
	const session = h.team.sessions.get('alpha');
	if (!session) throw new Error('Missing fixture terminal.');
	await sendMessage('beta', 'alpha', 'PRIVATE_DRAFT');
	await until(() => Promise.resolve(h.inputs.some((input) => input.startsWith(PASTE))), 'paste');
	session.stopRequested = true;
	await nativeDraft(true);
	await nativeDraft(false);
	await nativeDraft(true);
	finishPaste();
	await until(
		async () => (await wakeDeliveryStatus('alpha', nonce)).latest?.state === 'uncertain',
		'uncertain outcome',
	);
	expect(await claudeTurn('alpha', nonce)).toMatchObject({ phase: 'idle', draft: true });
	expect(terminalDraft(session.pty).draft).toBe(true);
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(false);
	expect(h.inputs.filter((input) => input === '\r')).toHaveLength(0);
}, 20000);
