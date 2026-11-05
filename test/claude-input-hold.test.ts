import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { setClaudeDelivery } from '../src/claude-delivery.ts';
import { claudeInputHold } from '../src/claude-notice-hold.ts';
import { claudeNoticeAllowed } from '../src/claude-turn-state.ts';
import { terminalDraft } from '../src/desktop/terminal-draft.ts';
import { deliveryView, noticesHeldPrefix } from '../src/mail-session.ts';
import { sendMessage } from '../src/mailbox.ts';
import { RECEIVER_FALLBACK_MS } from '../src/receiver-cadence.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { terminalHarness } from './fixtures/owned-terminal.ts';
import { attachFixtureReceiver, waitForNotice } from './fixtures/wake-team.ts';

// Run-3 of wake attempt 3 (Carl, 2026-10-30) sat 95 s behind a human paste in its pane while its
// status kept an older "prompt holds a draft" line. A Claude seat held by human input in its pane
// now says so, without claiming what the box contains, and the gate itself is unchanged.

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let h: ReturnType<typeof terminalHarness>;
let stop: (() => Promise<void>) | undefined;
const oldHome = process.env.SUMMON_HOME;
const oldNonce = process.env.SUMMON_NONCE;
const nonce = 'held-claude-input';

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

async function waitForReason(match: (reason: string) => boolean): Promise<string> {
	for (let attempt = 0; attempt < 600; attempt++) {
		const { reason } = await deliveryView('alpha');
		if (match(reason)) return reason;
		await Bun.sleep(10);
	}
	throw new Error(`Delivery status did not settle: ${(await deliveryView('alpha')).reason}`);
}
/** Allow two full fallback cycles before checking a retained hold. */
const cycles = () => Bun.sleep(2 * RECEIVER_FALLBACK_MS + 300);

test('human input in the pane holds notices and says so; backspace keeps it, Ctrl+U releases it', async () => {
	const pty = h.team.sessions.get('alpha')?.pty;
	if (!pty) throw new Error('Missing fixture terminal.');
	const reason = claudeInputHold('alpha', nonce);
	expect(reason.startsWith(`${noticesHeldPrefix}alpha launch ${nonce}:`)).toBe(true);
	expect(reason).not.toContain('prompt holds');

	await h.team.input('alpha', 'pasted by accident');
	await sendMessage('beta', 'alpha', 'PRIVATE_HELD_BY_INPUT');
	expect(await waitForReason((value) => value === reason)).not.toContain('PRIVATE');
	expect((await deliveryView('alpha')).state).toBe('queued-only');
	// The native gate is open: only the pane's input tracker holds the notice.
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
	expect(h.inputs).toEqual(['pasted by accident']);

	// A backspace can empty the box, but the tracker still holds, and the status keeps saying so.
	await h.team.input('alpha', '\u007f');
	await cycles();
	expect(terminalDraft(pty).draft).toBe(true);
	expect((await deliveryView('alpha')).reason).toBe(reason);
	expect(h.inputs).toHaveLength(2);

	await h.team.input('alpha', '\u0015');
	await waitForNotice(h.inputs, 'mailbox event');
	expect(h.inputs.join('')).not.toContain('PRIVATE');
	await waitForReason((value) => value !== reason);
}, 30000);

test('with no input in the pane, the input hold is never written', async () => {
	await sendMessage('beta', 'alpha', 'PRIVATE_DELIVERED');
	await waitForNotice(h.inputs, 'mailbox event');
	await cycles();
	expect((await deliveryView('alpha')).reason).not.toBe(claudeInputHold('alpha', nonce));
}, 30000);
