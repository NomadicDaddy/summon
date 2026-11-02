import { afterEach, beforeEach, expect, test } from 'bun:test';

import { initializeActivity } from '../src/agent-activity.ts';
import { deliveryNotice, prepareMailNotice } from '../src/mail-notice.ts';
import { header, recordRead } from '../src/mail-read.ts';
import { pendingMessages, sendMessage } from '../src/mailbox.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await initializeActivity('alpha', 'route-launch');
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

const REQUEST_TEXT =
	'summon: 1 new mailbox event(s) for alpha. At the next safe boundary read summon --current-requests --format text before historical catch-up, then use summon-receive. Assess, confirm, act or hold; only user approval releases holds.';

test('a confirmation-only notice routes to summon --mail receive, which shows it', async () => {
	const id = await sendMessage('beta', 'alpha', 'Cannot proceed; need clarification.', {
		kind: 'confirmation',
	});
	const notice = await prepareMailNotice('alpha', 'route-launch');
	expect(notice?.text).toBe(
		'summon: 1 new confirmation(s) for alpha. summon --current-requests leaves confirmations out; read them with summon --mail receive at the next safe boundary. Reading one confirms nothing; reply or act only as its content requires.',
	);
	// The boundary the wording describes, through the real commands: the focused view omits it,
	// and receive returns it.
	const focused = await fixture.run(['--current-requests'], 'alpha');
	expect(focused.code).toBe(0);
	expect(focused.out).not.toContain(id);
	const received = await fixture.run(['--mail', 'receive'], 'alpha');
	expect(received.code).toBe(0);
	expect(received.out).toContain(id);
	expect(received.out).toContain('Cannot proceed; need clarification.');
});

test.each(['request', 'reply'] as const)(
	'a %s keeps the focused-read notice unchanged',
	async (kind) => {
		const first = await sendMessage('alpha', 'beta', 'Earlier request.');
		await sendMessage('beta', 'alpha', 'Please look.', {
			kind,
			...(kind === 'reply' ? { replyTo: first } : {}),
		});
		expect((await prepareMailNotice('alpha', 'route-launch'))?.text).toBe(REQUEST_TEXT);
	},
);

test('a request with a confirmation keeps the focused read and adds the receive route', async () => {
	await sendMessage('beta', 'alpha', 'Please look.');
	await sendMessage('beta', 'alpha', 'Done; no blocker.', { kind: 'confirmation' });
	const text = (await prepareMailNotice('alpha', 'route-launch'))?.text ?? '';
	expect(text).toStartWith('summon: 2 new mailbox event(s) for alpha. At the next safe boundary');
	expect(text).toEndWith(
		' 1 of them are confirmations, which summon --current-requests leaves out; read those with summon --mail receive.',
	);
});

test.each(['receipt', 'rest-ready'] as const)(
	'a %s alone produces no mail notice',
	async (kind) => {
		await sendMessage('beta', 'alpha', 'Mechanical.', { kind });
		expect(await prepareMailNotice('alpha', 'route-launch')).toBeUndefined();
	},
);

test('a confirmation read before sending is no longer needed', async () => {
	const id = await sendMessage('beta', 'alpha', 'Blocked on the slot.', { kind: 'confirmation' });
	const notice = await prepareMailNotice('alpha', 'route-launch');
	expect(notice).toBeDefined();
	// Reading it (through receive or a checkpoint page) records read state; that must not reply.
	const before = await pendingMessages('beta');
	await recordRead('alpha', await header('alpha', id));
	expect(await notice?.needed()).toBe(false);
	expect(await notice?.acknowledged()).toBe(true);
	expect(await prepareMailNotice('alpha', 'route-launch')).toBeUndefined();
	// No receipt, confirmation or reply went back to the sender.
	expect(await pendingMessages('beta')).toEqual(before);
});

test('deliveryNotice keeps every existing wording when no confirmation is counted', () => {
	expect(deliveryNotice('alpha', 'n', true, 1, 0)).toBe(REQUEST_TEXT);
	expect(deliveryNotice('alpha', 'n', true, 1, 0, 0)).toBe(REQUEST_TEXT);
	expect(deliveryNotice('alpha', 'n', true, 0, 1)).toContain('approval decision(s)');
	expect(deliveryNotice('alpha', 'n', false, 0, 0)).toContain('summon --mail ready n');
});
