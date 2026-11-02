import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { HeadDownState } from '../src/head-down-model.ts';

import { initializeActivity } from '../src/agent-activity.ts';
import { communicationState } from '../src/communication-state.ts';
import { readHeadDown, saveHeadDown, sessionHeartbeat } from '../src/head-down-model.ts';
import { deliverHeadDownResponse } from '../src/head-down-response.ts';
import { optionalText } from '../src/mail-files.ts';
import { sendMessage } from '../src/mailbox.ts';
import { NotificationNotSentError } from '../src/notification-delivery.ts';
import { operatorViewing } from '../src/operator-view.ts';
import { createWakeCoordinator } from '../src/wake-coordinator.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previousHome = process.env.SUMMON_HOME;
const nonce = 'test-launch';
const allowed = (): Promise<boolean> => Promise.resolve(true);
const marker = () => join(fixture.records, 'runtime/alpha', `${nonce}.head-down-response`);

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await initializeActivity('alpha', nonce);
	await sessionHeartbeat('alpha', nonce);
});
afterEach(async () => {
	if (previousHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousHome;
	await fixture.dispose();
});

async function seed(changes: Partial<HeadDownState> = {}): Promise<HeadDownState> {
	const state: HeadDownState = {
		id: randomUUID(),
		nonce,
		phase: 'active',
		goal: 'Bounded fixture goal',
		completion: 'Fixture complete',
		questionId: 1,
		approvedBy: 'operator',
		decision: 'approved',
		...changes,
	};
	await saveHeadDown('alpha', state);
	return state;
}

test('receiver delivers its approval once while ordinary work and cursors remain untouched', async () => {
	const state = await seed();
	await sendMessage('beta', 'alpha', 'PRIVATE_PENDING_BODY');
	const sent: string[] = [];
	const tick = createWakeCoordinator(
		'alpha',
		nonce,
		async (text, revalidate) => {
			expect(await revalidate?.()).toBe(true);
			sent.push(text);
		},
		() => true,
		allowed,
		{ noticeAllowed: allowed },
	);
	await tick();
	await tick();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain(`request ${state.id} was approved`);
	expect(sent[0]).not.toContain('PRIVATE_PENDING_BODY');
	expect(await optionalText(join(fixture.records, 'runtime/alpha/room.cursor'))).toBeUndefined();
	expect((await fixture.run(['--mail', 'receive'], 'alpha')).out).toContain(
		'PRIVATE_PENDING_BODY',
	);
});

test('decline reaches the requester without authorizing its goal', async () => {
	expect(
		(
			await fixture.run(
				['--head-down', 'request', 'Fixture goal', 'Fixture done', '--return-to-normal'],
				'alpha',
			)
		).code,
	).toBe(0);
	const state = await readHeadDown('alpha');
	if (!state) throw new Error('Missing request');
	expect((await fixture.run(['--head-down', 'decline', 'alpha', state.id])).code).toBe(0);
	expect((await readHeadDown('alpha'))?.decision).toBe('declined');
	const sent: string[] = [];
	expect(
		await deliverHeadDownResponse(
			'alpha',
			nonce,
			(text) => {
				sent.push(text);
				return Promise.resolve();
			},
			allowed,
		),
	).toBe(true);
	expect(sent[0]).toContain('was declined');
	expect(sent[0]).toContain('act only within that recorded decision');
});

test.each([
	{ phase: 'requested' as const },
	{ phase: 'ended' as const, reason: 'Task complete' },
	{ phase: 'ended' as const, reason: 'Declined' },
	{ nonce: 'old-launch' },
])('non-decisions and another launch never generate input: %j', async (changes) => {
	await seed(changes);
	let sent = 0;
	expect(
		await deliverHeadDownResponse(
			'alpha',
			nonce,
			() => {
				sent++;
				return Promise.resolve();
			},
			allowed,
		),
	).toBe(false);
	expect(sent).toBe(0);
});

test('missing authenticated decision actor cannot generate an approval response', async () => {
	const state = await seed();
	const withoutActor = { ...state };
	delete withoutActor.approvedBy;
	await saveHeadDown('alpha', withoutActor);
	let sent = 0;
	expect(
		await deliverHeadDownResponse(
			'alpha',
			nonce,
			() => {
				sent++;
				return Promise.resolve();
			},
			allowed,
		),
	).toBe(false);
	expect(sent).toBe(0);
});

test('a provider busy or draft hold defers the decision without consuming it', async () => {
	await seed();
	let ready = false;
	let sent = 0;
	const canSend = (): Promise<boolean> => Promise.resolve(ready);
	const send = (): Promise<void> => {
		sent++;
		return Promise.resolve();
	};
	expect(await deliverHeadDownResponse('alpha', nonce, send, canSend)).toBe(true);
	expect(await optionalText(marker())).toBeUndefined();
	expect(sent).toBe(0);
	ready = true;
	await deliverHeadDownResponse('alpha', nonce, send, canSend);
	expect(sent).toBe(1);
});

test('operator pause retains its decision until the pause is removed', async () => {
	await seed();
	const viewing = join(fixture.records, 'runtime/team-window/operator-view.json');
	await Bun.write(
		viewing,
		JSON.stringify({ name: 'alpha', pid: process.pid, expires: Date.now() + 5000 }),
	);
	expect(await operatorViewing('alpha')).toBe(true);
	let sent = 0;
	const send = (): Promise<void> => {
		sent++;
		return Promise.resolve();
	};
	await deliverHeadDownResponse('alpha', nonce, send, allowed);
	expect(sent).toBe(0);
	expect(await optionalText(marker())).toBeUndefined();
	await Bun.write(viewing, '{}');
	await deliverHeadDownResponse('alpha', nonce, send, allowed);
	expect(sent).toBe(1);
});

test('hibernation keeps the decision pending without provider input', async () => {
	await seed();
	expect((await fixture.run(['--hibernate', 'alpha'])).code).toBe(0);
	let sent = 0;
	await deliverHeadDownResponse(
		'alpha',
		nonce,
		() => {
			sent++;
			return Promise.resolve();
		},
		allowed,
	);
	expect(sent).toBe(0);
	expect(await optionalText(marker())).toBeUndefined();
});

test('communication halt prevents the coordinator from delivering a decision', async () => {
	await seed();
	expect((await fixture.run(['--comms', 'halt'])).code).toBe(0);
	expect((await communicationState()).paused).toBe(true);
	let sent = 0;
	const tick = createWakeCoordinator(
		'alpha',
		nonce,
		() => {
			sent++;
			return Promise.resolve();
		},
		() => true,
		allowed,
		{},
	);
	await tick();
	expect(sent).toBe(0);
	expect(await optionalText(marker())).toBeUndefined();
});

test('a definitely unsent decision retries, while an uncertain attempt never repeats', async () => {
	await seed();
	const unsent = await deliverHeadDownResponse(
		'alpha',
		nonce,
		() => Promise.reject(new NotificationNotSentError('draft appeared before input')),
		allowed,
	).catch((error: unknown) => error);
	expect(unsent).toBeInstanceOf(NotificationNotSentError);
	expect(await optionalText(marker())).toBeUndefined();
	let attempts = 0;
	const uncertain = (): Promise<void> => {
		attempts++;
		return Promise.reject(new Error('uncertain input'));
	};
	const failure = await deliverHeadDownResponse('alpha', nonce, uncertain, allowed).catch(
		(error: unknown) => error,
	);
	expect(failure).toBeInstanceOf(Error);
	expect(failure).toMatchObject({ message: 'uncertain input' });
	expect(await optionalText(marker())).toBeDefined();
	await deliverHeadDownResponse('alpha', nonce, uncertain, allowed);
	expect(attempts).toBe(1);
});

test('a queued sender revalidates the goal before writing input', async () => {
	const state = await seed();
	let inputs = 0;
	const failure = await deliverHeadDownResponse(
		'alpha',
		nonce,
		async (_text, revalidate) => {
			await saveHeadDown('alpha', { ...state, phase: 'ended', reason: 'Task complete' });
			if (!(await revalidate?.())) throw new NotificationNotSentError('goal changed');
			inputs++;
		},
		allowed,
	).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(NotificationNotSentError);
	expect(inputs).toBe(0);
	expect(await optionalText(marker())).toBeUndefined();
});

test('replacement receivers cannot both submit the same goal decision', async () => {
	await seed();
	let inputs = 0;
	const send = (): Promise<void> => {
		inputs++;
		return Promise.resolve();
	};
	await Promise.all([
		deliverHeadDownResponse('alpha', nonce, send, allowed),
		deliverHeadDownResponse('alpha', nonce, send, allowed),
	]);
	expect(inputs).toBe(1);
});

test('a corrupt attempt marker is refused rather than treated as permission to repeat', async () => {
	await seed();
	await Bun.write(marker(), 'invalid marker');
	let inputs = 0;
	const failure = await deliverHeadDownResponse(
		'alpha',
		nonce,
		() => {
			inputs++;
			return Promise.resolve();
		},
		allowed,
	).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(Error);
	expect(failure).toMatchObject({
		message: 'Invalid head-down response marker; inspect own delivery state.',
	});
	expect(inputs).toBe(0);
});
