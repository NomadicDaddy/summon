import { afterEach, beforeEach, expect, test } from 'bun:test';

import { initializeActivity, readActivity, setOwnActivity } from '../src/agent-activity.ts';
import {
	claudeNoticeAllowed,
	initializeClaudeTurn,
	observeClaudeTurn,
} from '../src/claude-turn-state.ts';
import { sendHuman } from '../src/local-room-access.ts';
import { markReady, saveDelivery } from '../src/mail-session.ts';
import { startMailWatcher } from '../src/mail-watcher.ts';
import { refreshRest, restCommand, restSuppressed } from '../src/rest.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

// Phillip #27670: a needs-user status must never hold an addressed @mention.
let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previousHome = process.env.SUMMON_HOME;
const previousAgent = process.env.SUMMON_AGENT;
const previousNonce = process.env.SUMMON_NONCE;
const nonce = 'needs-user-mention';
let stop: (() => Promise<void>) | undefined;
let sequence = 0;
/** Phillip posts as the operator, so the seat's agent identity is set aside for the post. */
async function phillipPosts(text: string): Promise<void> {
	delete process.env.SUMMON_AGENT;
	try {
		await sendHuman(text);
	} finally {
		process.env.SUMMON_AGENT = 'beta';
	}
}
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'beta';
	process.env.SUMMON_NONCE = nonce;
	sequence = 0;
	await initializeActivity('beta', nonce);
	await setOwnActivity('beta', 'needs-user', 'Waiting on Phillip for a decision');
});
afterEach(async () => {
	await stop?.();
	stop = undefined;
	if (previousHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousHome;
	if (previousAgent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previousAgent;
	if (previousNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = previousNonce;
	await fixture.dispose();
});

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (await check()) return;
		await Bun.sleep(10);
	}
	throw new Error('Expected notice was not observed.');
}

/** A Claude seat at rest in its prompt: attached, then Claude's own idle prompt. */
async function idleClaudeSeat(): Promise<void> {
	await initializeClaudeTurn('beta', nonce, 'exact-thread', 'owned-observer');
	await saveDelivery('beta', {
		nonce,
		thread: 'exact-thread',
		pid: process.pid,
		state: 'unconfirmed',
		reason: '',
	});
	await markReady('beta', nonce);
	for (const kind of ['attach', 'idle'] as const)
		await observeClaudeTurn('beta', nonce, 'owned-observer', {
			session: 'exact-thread',
			epoch: 1,
			sequence: ++sequence,
			kind,
			turn: null,
			draft: false,
			completed: false,
		});
}

/** The seat's receiver, behind the Team Window gate for a Claude seat: idle turn, same launch. */
async function receivedNotices(): Promise<string[]> {
	const notices: string[] = [];
	stop = await startMailWatcher(
		'beta',
		nonce,
		(text) => {
			notices.push(text);
			return Promise.resolve();
		},
		{
			noticeAllowed: async () =>
				(await claudeNoticeAllowed('beta', nonce)) &&
				(await readActivity('beta'))?.nonce === nonce,
		},
	);
	await eventually(() => notices.length > 0);
	return notices;
}

test('a needs-user seat with an idle Claude turn receives an addressed human mention', async () => {
	await idleClaudeSeat();
	expect((await readActivity('beta'))?.state).toBe('needs-user');
	expect(await claudeNoticeAllowed('beta', nonce)).toBe(true);
	await phillipPosts('@beta PRIVATE_NEEDS_USER_MENTION');
	const notices = await receivedNotices();
	expect(notices[0]).toContain('summon room through 1');
	expect(notices[0]).not.toContain('PRIVATE_');
});

test('rest confirmed under needs-user is ended by an addressed mention, which is then delivered', async () => {
	await idleClaudeSeat();
	await restCommand(['ready']);
	expect((await refreshRest('beta'))?.mode).toBe('ready');
	expect(await restSuppressed('beta')).toBe(true);
	await phillipPosts('@beta PRIVATE_NEEDS_USER_REST');
	const woken = await refreshRest('beta');
	expect(woken?.mode).toBe('wake-requested');
	expect(woken?.reason).toContain('Room message #1 after acknowledged cursor #0 addresses you');
	expect(await restSuppressed('beta')).toBe(false);
	const notices = await receivedNotices();
	expect(notices[0]).toContain('summon room through 1');
	expect(notices[0]).not.toContain('PRIVATE_');
});
