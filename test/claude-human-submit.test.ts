import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { setClaudeDelivery } from '../src/claude-delivery.ts';
import { claudeNoticeAllowed, initializeClaudeTurn } from '../src/claude-turn-state.ts';
import { recordClaudeInput } from '../src/desktop/claude-terminal-input.ts';
import { inputToOwnedTerminal } from '../src/desktop/owned-terminal-input.ts';
import { terminalDraft } from '../src/desktop/terminal-draft.ts';
import { locked } from '../src/mail-files.ts';
import { markReady, saveDelivery } from '../src/mail-session.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { terminalHarness } from './fixtures/owned-terminal.ts';
import { observeFixtureClaudeIdle } from './fixtures/wake-team.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let h: ReturnType<typeof terminalHarness>;
const oldHome = process.env.SUMMON_HOME;
const oldNonce = process.env.SUMMON_NONCE;
const nonce = 'human-claude';
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_NONCE = nonce;
	await setClaudeDelivery('checkpoint');
	h = terminalHarness();
	await h.team.start('alpha', false);
	await initializeActivity('alpha', nonce);
	await initializeClaudeTurn('alpha', nonce, 'exact', 'fixture-observer');
	await saveDelivery('alpha', {
		nonce,
		thread: 'exact',
		pid: process.pid,
		state: 'unconfirmed',
		reason: '',
	});
	await markReady('alpha', nonce);
	await observeFixtureClaudeIdle('alpha', nonce);
});
afterEach(async () => {
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	if (oldNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = oldNonce;
	await fixture.dispose();
});

test.each(['normal', 'typing', 'failure'] as const)(
	'Claude native busy and draft are set before physical Enter (%s)',
	async (behavior) => {
		// This physical-Enter race belongs to the terminal delivery mode, which past fixtures
		// accidentally exercised through the default Live launch before the paths were split.
		const session = h.team.sessions.get('alpha');
		if (!session) throw new Error('Missing owned terminal fixture');
		expect(session.terminalNotices).toBe(true);
		const path = join(fixture.records, `runtime/alpha/${nonce}.claude-turn`);
		const entered = Promise.withResolvers<undefined>();
		const release = Promise.withResolvers<undefined>();
		const hold = locked(`${path}.lock`, async () => {
			entered.resolve(undefined);
			await release.promise;
		});
		await entered.promise;
		const writes: string[] = [];
		session.pty.write = (text) => {
			const metadata = JSON.parse(readFileSync(path, 'utf8')) as {
				phase: string;
				turn: unknown;
			};
			expect(metadata.phase).toBe('busy');
			expect(metadata.turn).toBeNull();
			expect(terminalDraft(session.pty).draft).toBe(true);
			if (behavior === 'failure') throw new Error('Unknown physical Enter outcome');
			writes.push(String(text));
			if (behavior === 'typing') recordClaudeInput(session.pty, 'newer human draft', true);
		};
		const input = inputToOwnedTerminal('alpha', '\r', true, () => session);
		await Bun.sleep(20);
		expect(writes).toEqual([]);
		expect(terminalDraft(session.pty).draft).toBe(true);
		release.resolve(undefined);
		await hold;
		if (behavior === 'failure') {
			expect(input).rejects.toThrow('Unknown physical');
			await input.catch(() => {});
		} else await input;
		expect(terminalDraft(session.pty).draft).toBe(behavior !== 'normal');
	},
);

test('live-channel human typing is tracked even without a competing terminal receiver', async () => {
	await setClaudeDelivery('live');
	h = terminalHarness();
	await h.team.start('alpha', false);
	const session = h.team.sessions.get('alpha');
	if (!session) throw new Error('Missing owned terminal fixture');
	expect(session.terminalNotices).toBe(false);
	await inputToOwnedTerminal('alpha', 'human draft', true, () => session);
	expect(terminalDraft(session.pty).draft).toBe(true);
	await inputToOwnedTerminal('alpha', '\r', true, () => session);
	expect(terminalDraft(session.pty).draft).toBe(false);
	// Native submit/start events, not a physical Enter that might be ignored, withdraw idle.
	expect(await claudeNoticeAllowed('alpha', nonce)).toBe(true);
});
