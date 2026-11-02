import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { humanOrHeadDownSteering } from '../src/automatic-interruptions.ts';
import { readPendingMentionWake } from '../src/desktop/mention-wakes.ts';
import { tickSchedules } from '../src/desktop/schedules.ts';
import { Team } from '../src/desktop/team.ts';
import { canManageHeadDown, delegateHeadDown } from '../src/head-down-access.ts';
import {
	headDownActive,
	headDownView,
	readHeadDown,
	sessionHeartbeat,
} from '../src/head-down-model.ts';
import { decideHeadDown, endHeadDown, finishHeadDownLaunch } from '../src/head-down.ts';
import { sendHuman } from '../src/local-room-access.ts';
import { localEvents } from '../src/local-room.ts';
import { atomicWrite, optionalText } from '../src/mail-files.ts';
import { startMailWatcher } from '../src/mail-watcher.ts';
import { sendMessage } from '../src/mailbox.ts';
import { localCursorPath } from '../src/room-cursor.ts';
import { answerRoom } from '../src/room-question-access.ts';
import { createSchedule, listSchedules } from '../src/schedules.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { notifyLocalRoom } from './fixtures/wake-notice.ts';
import { attachFixtureReceiver, waitForNotice } from './fixtures/wake-team.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const original = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	for (const name of ['alpha', 'beta']) {
		await initializeActivity(name, 'test-launch');
		await sessionHeartbeat(name, 'test-launch');
	}
});
afterEach(async () => {
	if (original === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = original;
	await fixture.dispose();
});

async function request() {
	const result = await fixture.run(
		[
			'--head-down',
			'request',
			'Complete the bounded fix',
			'Gate passes and change is committed',
			'--return-to-normal',
		],
		'alpha',
	);
	expect(result.code).toBe(0);
	const state = await readHeadDown('alpha');
	if (!state) throw new Error('Missing request');
	return state;
}

test('request requires an explicit commitment and actual approval before muting', async () => {
	const missing = await fixture.run(['--head-down', 'request', 'goal', 'condition'], 'alpha');
	expect(missing.code).toBe(1);
	const state = await request();
	expect(await headDownActive('alpha')).toBe(false);
	const self = await fixture.run(['--head-down', 'approve', 'alpha', state.id], 'alpha');
	expect(self.code).toBe(1);
	const peer = await fixture.run(['--head-down', 'approve', 'alpha', state.id], 'beta');
	expect(peer.code).toBe(1);
	await answerRoom(state.questionId, 0);
	expect(await headDownActive('alpha')).toBe(true);
	expect((await readHeadDown('alpha'))?.approvedBy).toBe('operator');
	expect((await readHeadDown('alpha'))?.decision).toBe('approved');
});

test('delegation is operator controlled, narrow and revocable', async () => {
	const state = await request();
	const denied = await fixture.run(['--head-down', 'delegate', 'beta', 'on'], 'beta');
	expect(denied.code).toBe(1);
	await delegateHeadDown('beta', true);
	const approved = await fixture.run(['--head-down', 'approve', 'alpha', state.id], 'beta');
	expect(approved.code).toBe(0);
	expect((await readHeadDown('alpha'))?.approvedBy).toBe('beta');
	await delegateHeadDown('beta', false);
	const revoked = await fixture.run(
		['--head-down', 'steer', 'alpha', state.id, 'new direction'],
		'beta',
	);
	expect(revoked.code).toBe(1);
	expect(await headDownActive('alpha')).toBe(true);
	await delegateHeadDown('beta', true);
	const steer = await fixture.run(
		['--head-down', 'steer', 'alpha', state.id, 'Stop and discuss'],
		'beta',
	);
	expect(steer.code).toBe(0);
	expect(await headDownActive('alpha')).toBe(false);
	const event = (await localEvents()).at(-1);
	if (!event) throw new Error('Missing steering event');
	expect(await humanOrHeadDownSteering(event, 'alpha')).toBe(true);
	expect(await humanOrHeadDownSteering({ ...event, id: event.id + 1 }, 'alpha')).toBe(false);
});

test('removal revokes delegated power before the name can be reused', async () => {
	await delegateHeadDown('beta', true);
	expect(await canManageHeadDown('beta')).toBe(true);
	const removed = await fixture.run(['--remove', 'beta']);
	expect(removed.code).toBe(0);
	expect(await canManageHeadDown('beta')).toBe(false);
});

test('mentions remain unread during the mode and catch up after owner completion', async () => {
	const state = await request();
	await decideHeadDown('alpha', state.id, true);
	await sendHuman('@alpha ordinary mention must wait');
	const sent: string[] = [];
	const send = (text: string): Promise<void> => {
		sent.push(text);
		return Promise.resolve();
	};
	await notifyLocalRoom('alpha', 'test-launch', send);
	expect(sent).toHaveLength(0);
	expect(await optionalText(localCursorPath('alpha'))).toBeUndefined();
	const ended = await fixture.run(
		['--head-down', 'end', 'alpha', state.id, 'Complete: gate passed, committed'],
		'alpha',
	);
	expect(ended.code).toBe(0);
	await notifyLocalRoom('alpha', 'test-launch', send);
	expect(sent).toHaveLength(1);
	expect(await headDownView('alpha')).toBeUndefined();
	expect((await readHeadDown('alpha'))?.reason).toContain('gate passed');
});

test('launch changes invalidate approval and old cleanup cannot end the new request', async () => {
	const state = await request();
	await initializeActivity('alpha', 'different-launch');
	expect(await headDownView('alpha')).toBeUndefined();
	const rejected = await decideHeadDown('alpha', state.id, true).catch((error: unknown) =>
		String(error),
	);
	expect(rejected).toContain('previous launch');
	await finishHeadDownLaunch('alpha');
	expect((await readHeadDown('alpha'))?.phase).toBe('ended');
	await initializeActivity('alpha', 'test-launch');
	const next = await request();
	await decideHeadDown('alpha', next.id, true);
	await finishHeadDownLaunch('alpha', 'different-launch');
	expect(await headDownActive('alpha')).toBe(true);
	await finishHeadDownLaunch('alpha', 'test-launch');
	expect(await headDownActive('alpha')).toBe(false);
	expect((await localEvents()).at(-1)?.text).not.toContain('@alpha');
});

test('overdue is liveness information, never an implicit goal deadline or stop', async () => {
	const state = await request();
	await decideHeadDown('alpha', state.id, true);
	expect(
		(await localEvents()).some(
			(event) => event.answer?.questionId === state.questionId && event.answer.choice === 0,
		),
	).toBe(true);
	const view = await headDownView('alpha', Date.now() + 21_000);
	expect(view?.overdue).toBe(true);
	expect(view?.phase).toBe('active');
	const rejected = await endHeadDown('alpha', 'stale-id', 'complete').catch((error: unknown) =>
		String(error),
	);
	expect(rejected).toContain('changed');
	expect(await headDownActive('alpha')).toBe(true);
});

test('native mail receiver holds notices and preserves the body until return to Normal', async () => {
	const state = await request();
	expect(
		(await fixture.run(['--status', 'idle', 'Waiting for head-down approval'], 'alpha')).code,
	).toBe(0);
	expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
	await decideHeadDown('alpha', state.id, true);
	const sent: string[] = [];
	const stop = await startMailWatcher('alpha', 'test-launch', (text) => {
		sent.push(text);
		return Promise.resolve();
	});
	try {
		await sendMessage('beta', 'alpha', 'Queued while head-down');
		await Bun.sleep(2200);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain(`request ${state.id} was approved`);
		expect(sent[0]).not.toContain('Queued while head-down');
		await endHeadDown('alpha', state.id, 'Task complete');
		// A room notice can arrive first; only the mailbox notice satisfies this wait.
		for (
			let attempt = 0;
			attempt < 150 && !sent.some((text) => text.includes('mailbox readiness'));
			attempt++
		)
			await Bun.sleep(100);
		expect(sent.some((text) => text.includes('mailbox readiness'))).toBe(true);
		const pending = await fixture.run(['--mail', 'receive'], 'alpha');
		expect(pending.out).toContain('Queued while head-down');
	} finally {
		await stop();
	}
}, 20000);

test('PTY keeps ordinary mentions and schedules queued while allowing direct input and authorized steering', async () => {
	await atomicWrite(
		join(fixture.records, 'alpha.json'),
		JSON.stringify(newRecord('alpha', fixture.root, 'kilo')),
	);
	const inputs: string[] = [];
	const team = new Team(
		'bun',
		'cli.ts',
		() => {},
		() => ({
			pid: process.pid,
			onData: () => ({ dispose: () => {} }),
			onExit: () => ({ dispose: () => {} }),
			write: (text) => inputs.push(String(text)),
			resize: () => {},
			kill: () => {},
		}),
	);
	await team.start('alpha');
	const state = await request();
	await decideHeadDown('alpha', state.id, true);
	const mention = await sendHuman('@alpha ordinary queued message');
	await team.wakeMentions(mention);
	expect(inputs).toHaveLength(0);
	expect((await readPendingMentionWake('alpha'))?.through).toBe(mention.id);
	await team.input('alpha', 'direct operator input');
	expect(inputs).toEqual(['direct operator input']);
	await createSchedule({
		owner: 'alpha',
		title: 'fixture task',
		everyMinutes: 1,
		prompt: 'fixture',
	});
	const schedules = await listSchedules();
	for (const item of schedules.schedules) item.nextDueAt = 0;
	await atomicWrite(join(fixture.records, 'schedules', 'state.json'), JSON.stringify(schedules));
	await tickSchedules(team);
	expect((await listSchedules()).runs).toHaveLength(0);
	await delegateHeadDown('beta', true);
	const steered = await fixture.run(
		['--head-down', 'steer', 'alpha', state.id, 'Discuss the goal'],
		'beta',
	);
	expect(steered.code).toBe(0);
	const event = (await localEvents()).at(-1);
	if (!event) throw new Error('Missing steering');
	await team.wakeMentions(event);
	// Authorized steering ends head-down, but must not append to the human's pending draft.
	expect(inputs).toHaveLength(1);
	expect((await readPendingMentionWake('alpha'))?.through).toBe(event.id);
	await team.input('alpha', '\r');
	await team.flushPendingMentionWakes();
	expect(inputs).toHaveLength(2);
	const stop = await attachFixtureReceiver(team, 'alpha');
	try {
		await waitForNotice(inputs, `through ${event.id}`);
		expect(inputs).toHaveLength(3);
	} finally {
		await stop();
	}
	await tickSchedules(team);
	expect((await listSchedules()).runs).toHaveLength(1);
});
