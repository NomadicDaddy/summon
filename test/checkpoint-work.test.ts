import { afterEach, beforeEach, expect, test } from 'bun:test';

import { initializeActivity, readActivity } from '../src/agent-activity.ts';
import { readHeadDown, sessionHeartbeat } from '../src/head-down-model.ts';
import { decideHeadDown } from '../src/head-down.ts';
import { providerUp } from '../src/launch-phase.ts';
import { prepareLocalRoomNotice } from '../src/local-room-live.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { saveDelivery } from '../src/mail-session.ts';
import { mailboxPrompt, sendMessage } from '../src/mailbox.ts';
import { sessionPrompt } from '../src/providers.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let h: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	h = await mailHarness();
	process.env.SUMMON_HOME = h.records;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await h.dispose();
});

interface Batch {
	receipt: string;
	changed: boolean;
	more: boolean;
	room?: { events: { id: number; text: string }[] };
	work?: { pageBudget: number; taskStepsBeforeRoutinePage: number; packageComplete: boolean };
}
async function checkpoint(receipt?: string, work = true): Promise<Batch> {
	const result = await h.run(
		['--checkpoint', ...(receipt ? [receipt] : []), ...(work ? ['--work'] : [])],
		'alpha',
	);
	expect({ code: result.code, error: result.error }).toEqual({ code: 0, error: '' });
	return JSON.parse(result.out) as Batch;
}
async function post(text: string, from = 'beta', replyTo: number | null = null) {
	return appendLocalEvent({
		sender: { kind: from === 'operator' ? 'user' : 'agent', id: from },
		text,
		replyTo,
		source: 'local',
	});
}

test('busy-room work capture stays finite, preserves every deferred post and never claims quiet', async () => {
	// Replay 24 routine arrivals across a logical 14-minute window, without sleeping.
	for (let i = 0; i < 24; i++)
		await post(`routine at ${Math.round((i * 14 * 60_000) / 23)}: ${'x'.repeat(1000)}`);
	expect(await prepareLocalRoomNotice('alpha', 'test-launch')).toBeUndefined();
	const first = await checkpoint();
	const firstCount = first.room?.events.length ?? 0;
	expect(firstCount).toBeGreaterThan(0);
	expect(firstCount).toBeLessThan(24);
	expect(first.work).toMatchObject({ pageBudget: 1, taskStepsBeforeRoutinePage: 2 });
	await post('later arrival while working');
	const second = await checkpoint(first.receipt);
	expect(second.room?.events.map((item) => item.id)).toEqual(
		Array.from({ length: 24 - firstCount }, (_, index) => firstCount + index + 1),
	);
	const final = await checkpoint(second.receipt);
	expect(final.changed).toBe(false);
	expect(final.more).toBe(true);
	const boundary = await checkpoint(final.receipt);
	expect(boundary.work?.packageComplete).toBe(true);
	expect(boundary.room).toBeUndefined();
	expect(boundary.receipt).toBeUndefined();
	// New capture is explicit; the arrival wasn't acknowledged by the old package.
	const next = await checkpoint(final.receipt);
	expect(next.room?.events.map((item) => item.id)).toEqual([25]);
	const nextFinal = await checkpoint(next.receipt);
	await checkpoint(nextFinal.receipt);
	const quiet = await checkpoint(undefined, false);
	expect(quiet).toMatchObject({ changed: false, more: false });
	expect(quiet.work).toBeUndefined();
}, 15_000);

test('work-mode quiet receipt captures the post that wakes an idle session', async () => {
	const quiet = await checkpoint();
	expect(quiet).toMatchObject({ changed: false, more: false });
	await post('new post after quiet');
	const fresh = await checkpoint(quiet.receipt);
	expect(fresh.room?.events.map((item) => item.text)).toEqual(['new post after quiet']);
	const final = await checkpoint(fresh.receipt);
	const result = await h.run(
		['--checkpoint', final.receipt, '--work', '--format', 'text'],
		'alpha',
	);
	expect(result.code).toBe(0);
	expect(result.out).toContain('CHECKPOINT WORK BOUNDARY');
	expect(result.out).not.toContain('CHECKPOINT QUIET');
	const caughtUp = await checkpoint();
	expect(caughtUp).toMatchObject({ changed: false, more: false });
	expect(caughtUp.work).toBeUndefined();
});

test('mentions, operator input, replies and mail bypass a deferred historical page', async () => {
	const own = await post('my task progress', 'alpha');
	for (let i = 0; i < 24; i++) await post(`routine ${i}`);
	const frozen = await checkpoint();
	const mention = await post('@alpha decision needed');
	const reply = await post('reply needed', 'beta', own.id);
	const human = await post('operator instruction', 'operator');
	const mail = await sendMessage('beta', 'alpha', 'addressed mail');
	const read = await h.run(['--current-requests'], 'alpha');
	expect(read.code).toBe(0);
	const view = JSON.parse(read.out) as {
		room: { events: { id: number }[] };
		mail: { messages: { header: { id: string } }[] };
	};
	for (const id of [mention.id, reply.id, human.id])
		expect(view.room.events.map((item) => item.id)).toContain(id);
	expect(view.mail.messages.map((item) => item.header.id)).toContain(mail);
	// Focused reads must not consume or replace the frozen historical page.
	const replay = await checkpoint();
	expect(replay.room).toEqual(frozen.room);
	expect(replay.receipt).toBe(frozen.receipt);
});

test('head-down return can finish its frozen history and resume work while later arrivals wait', async () => {
	await initializeActivity('alpha', 'test-launch');
	await sessionHeartbeat('alpha', 'test-launch');
	const request = await h.run(
		['--head-down', 'request', 'bounded task', 'tested result', '--return-to-normal'],
		'alpha',
	);
	expect(request.code).toBe(0);
	const state = await readHeadDown('alpha');
	if (!state) throw new Error('Missing head-down request');
	await decideHeadDown('alpha', state.id, true);
	for (let i = 0; i < 24; i++) await post(`queued while head-down ${i}: ${'x'.repeat(1000)}`);
	expect((await h.run(['--head-down', 'end', 'alpha', state.id, 'complete'], 'alpha')).code).toBe(
		0,
	);
	let batch = await checkpoint();
	let pages = 0;
	while (batch.changed) {
		pages++;
		await post(`new routine arrival ${pages}`);
		// Actual task/status work can run between historical pages, even after head-down.
		expect((await h.run(['--status', 'busy', `next task step ${pages}`], 'alpha')).code).toBe(
			0,
		);
		batch = await checkpoint(batch.receipt);
	}
	expect(pages).toBe(2);
	const complete = await checkpoint(batch.receipt);
	expect(complete.work?.packageComplete).toBe(true);
	expect((await readActivity('alpha'))?.workingOn).toBe('next task step 2');
	expect((await checkpoint()).room?.events.map((item) => item.text)).toEqual([
		'new routine arrival 1',
		'new routine arrival 2',
	]);
});

for (const [provider, evidence] of [
	['claude', 'claude-mcp-initialized'],
	['codex', 'codex-session-start'],
	['grok', 'grok-session-metadata'],
	['kilo', 'kilo-owned-session'],
] as const) {
	test(`${provider} relaunch guidance completes readiness and first status before busy history`, async () => {
		const prompt = sessionPrompt(
			newRecord('alpha', h.root, provider),
			'alpha',
			'',
			[],
			await mailboxPrompt('alpha'),
		);
		const order = prompt.indexOf('Startup order, before historical catch-up:');
		expect(order).toBeGreaterThan(-1);
		expect(order).toBeLessThan(prompt.indexOf('Then run summon --checkpoint.'));
		expect(prompt).toContain('two concrete steps');
		const rest = prompt.indexOf('check summon --work once');
		expect(rest).toBeGreaterThan(order);
		expect(rest).toBeLessThan(prompt.indexOf('Your persistent scratch folder:'));
		expect(prompt).toContain('on confirmation, end your turn and wait for new input');
		expect(prompt).toContain('preserve needs-user and its Room line for the operator');
		expect(prompt).not.toContain('a wait on a teammate or Phillip');
		expect(prompt).toContain('Never rest while your own child process is running');
		await initializeActivity('alpha', 'test-launch', provider);
		await providerUp('alpha', 'test-launch', provider, evidence);
		await saveDelivery('alpha', {
			nonce: 'test-launch',
			pid: process.pid,
			state: 'unconfirmed',
			reason: '',
			thread: 'fixture',
		});
		for (let i = 0; i < 24; i++) await post(`busy startup history ${i}`);
		expect((await readActivity('alpha'))?.launch?.phase).toBe('logging-in');
		const ready = await h.run(['--mail', 'ready', 'test-launch'], 'alpha');
		expect(ready.code).toBe(0);
		expect(JSON.parse(ready.out)).toMatchObject({ ready: true });
		const status = await h.run(['--status', 'busy', 'Resume own task'], 'alpha');
		expect(status.code).toBe(0);
		expect((await readActivity('alpha'))?.launch).toBeUndefined();
		expect((await checkpoint()).room?.events).toHaveLength(24);
		expect((await readActivity('alpha'))?.workingOn).toBe('Resume own task');
	});
}
