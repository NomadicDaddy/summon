import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { TerminalProcess } from '../src/desktop/team.ts';

import { initializeActivity } from '../src/agent-activity.ts';
import { startClaudeChannel } from '../src/claude-channel-delivery.ts';
import { claudeNoticeHold } from '../src/claude-notice-hold.ts';
import { initializeClaudeTurn, observeClaudeTurn } from '../src/claude-turn-state.ts';
import { claudeNoticeSender, recordClaudeInput } from '../src/desktop/claude-terminal-input.ts';
import { deliveryView, markReady, saveDelivery } from '../src/mail-session.ts';
import { sendMessage } from '../src/mailbox.ts';
import {
	NotificationEnterWithheldError,
	NotificationUnsubmittedError,
} from '../src/notification-delivery.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

function terminal(fail?: (data: string) => boolean) {
	const writes: string[] = [];
	const pty: TerminalProcess = {
		pid: process.pid,
		onData: () => ({ dispose: () => {} }),
		onExit: () => ({ dispose: () => {} }),
		write: (data) => {
			if (fail?.(String(data))) throw new Error('terminal write failed');
			writes.push(String(data));
		},
		resize: () => {},
		kill: () => {},
	};
	return { pty, writes };
}
async function refusal(result: Promise<void>): Promise<unknown> {
	try {
		await result;
	} catch (error: unknown) {
		return error;
	}
	throw new Error('Expected the notice to be refused.');
}

test('only the two refusals between paste and Enter are typed as a withheld Enter', async () => {
	const human = terminal();
	const typed = await refusal(
		claudeNoticeSender(
			human.pty,
			() => Promise.resolve(),
			() => {
				recordClaudeInput(human.pty, 'x');
				return Promise.resolve();
			},
		)('notice'),
	);
	expect(typed).toBeInstanceOf(NotificationEnterWithheldError);
	expect((typed as NotificationEnterWithheldError).pasteVersion).toBe(0);
	expect(human.writes).toHaveLength(1);

	let checks = 0;
	const paused = terminal();
	const closed = await refusal(
		claudeNoticeSender(
			paused.pty,
			() => {
				if (++checks > 1) return Promise.reject(new Error('communications paused'));
				return Promise.resolve();
			},
			() => Promise.resolve(),
		)('notice'),
	);
	expect(closed).toBeInstanceOf(NotificationEnterWithheldError);
	expect(paused.writes).toHaveLength(1);

	const enter = terminal((data) => data === '\r');
	const failedEnter = await refusal(
		claudeNoticeSender(
			enter.pty,
			() => Promise.resolve(),
			() => Promise.resolve(),
		)('notice'),
	);
	expect(failedEnter).toBeInstanceOf(NotificationUnsubmittedError);
	expect(failedEnter).not.toBeInstanceOf(NotificationEnterWithheldError);

	const paste = terminal((data) => data.startsWith('\u001b[200~'));
	const failedPaste = await refusal(
		claudeNoticeSender(
			paste.pty,
			() => Promise.resolve(),
			() => Promise.resolve(),
		)('notice'),
	);
	expect(failedPaste).toBeInstanceOf(NotificationUnsubmittedError);
	expect(failedPaste).not.toBeInstanceOf(NotificationEnterWithheldError);
});

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let stopChannel: (() => Promise<void>) | undefined;
const oldHome = process.env.SUMMON_HOME;
const oldNonce = process.env.SUMMON_NONCE;
const nonce = 'live-held-claude';

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_NONCE = nonce;
	await initializeActivity('alpha', nonce);
	await saveDelivery('alpha', {
		nonce,
		thread: 'exact-thread',
		pid: process.pid,
		state: 'unconfirmed',
		reason: '',
	});
	await initializeClaudeTurn('alpha', nonce, 'exact-thread', 'owned-observer');
});
afterEach(async () => {
	await stopChannel?.();
	stopChannel = undefined;
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	if (oldNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = oldNonce;
	await fixture.dispose();
});

test('a live-channel Claude seat held by a busy turn says why, like a terminal seat', async () => {
	let sequence = 0;
	for (const [kind, turn] of [
		['attach', null],
		['start', 'one'],
	] as const)
		await observeClaudeTurn('alpha', nonce, 'owned-observer', {
			session: 'exact-thread',
			epoch: 1,
			sequence: ++sequence,
			kind,
			turn,
			draft: false,
			completed: false,
		});
	await markReady('alpha', nonce);
	const sent: string[] = [];
	stopChannel = await startClaudeChannel('alpha', nonce, (text) => {
		sent.push(text);
		return Promise.resolve();
	});
	await sendMessage('beta', 'alpha', 'PRIVATE_LIVE_HELD');
	const expected = await claudeNoticeHold('alpha', nonce);
	if (!expected) throw new Error('The fixture turn should hold notices.');
	for (let attempt = 0; (await deliveryView('alpha')).reason !== expected; attempt++) {
		if (attempt > 600)
			throw new Error(`Hold reason never written: ${(await deliveryView('alpha')).reason}`);
		await Bun.sleep(10);
	}
	expect(sent).toHaveLength(0);
	expect((await deliveryView('alpha')).reason).not.toContain('PRIVATE');
}, 15000);
