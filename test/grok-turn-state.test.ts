import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
	grokInputSubmitted,
	grokNoticeAllowed,
	grokNoticeHold,
	grokTurn,
	initializeGrokTurn,
	observeGrokTurn,
	reserveGrokNotice,
} from '../src/grok-turn-state.ts';
import { markReady, saveDelivery } from '../src/mail-session.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
const previousNonce = process.env.SUMMON_NONCE;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_NONCE = 'turn-launch';
	await initializeGrokTurn('alpha', 'turn-launch', 'native-thread');
	await saveDelivery('alpha', {
		nonce: 'turn-launch',
		thread: 'native-thread',
		pid: process.pid,
		state: 'unconfirmed',
		reason: '',
	});
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	if (previousNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = previousNonce;
	await fixture.dispose();
});

async function event(extra: Record<string, unknown> = {}): Promise<void> {
	await Bun.sleep(5);
	await observeGrokTurn('alpha', 'turn-launch', {
		sessionId: 'native-thread',
		hook_event_name: 'Notification',
		notificationType: 'idle_prompt',
		timestamp: new Date().toISOString(),
		...extra,
	});
}

test('one bootstrap is reserved before input, with later work held until native idle', async () => {
	expect(await grokNoticeAllowed('alpha', 'turn-launch')).toBe(true);
	await reserveGrokNotice('alpha', 'turn-launch');
	expect(await grokNoticeAllowed('alpha', 'turn-launch')).toBe(false);
	expect(reserveGrokNotice('alpha', 'turn-launch')).rejects.toThrow('verified turn completion');
	await event();
	expect(await grokNoticeAllowed('alpha', 'turn-launch')).toBe(true);
	await reserveGrokNotice('alpha', 'turn-launch');
	expect(await grokNoticeAllowed('alpha', 'turn-launch')).toBe(false);
});

test('readiness confirmed during startup cannot create another bootstrap wake', async () => {
	await markReady('alpha', 'turn-launch');
	expect(await grokNoticeAllowed('alpha', 'turn-launch')).toBe(false);
	await event();
	expect(await grokNoticeAllowed('alpha', 'turn-launch')).toBe(true);
});

test('hold reasons distinguish bootstrap, missing, unknown and busy without changing native state', async () => {
	expect(await grokNoticeHold('alpha', 'turn-launch')).toBeUndefined();
	expect(await grokNoticeHold('alpha', 'missing-launch')).toContain('no Grok turn record');
	expect(await grokTurn('alpha', 'missing-launch')).toBeUndefined();
	await markReady('alpha', 'turn-launch');
	const unknown = await grokTurn('alpha', 'turn-launch');
	expect(await grokNoticeHold('alpha', 'turn-launch')).toContain('state is unknown');
	expect(await grokTurn('alpha', 'turn-launch')).toEqual(unknown);
	await event();
	expect(await grokNoticeHold('alpha', 'turn-launch')).toBeUndefined();
	await reserveGrokNotice('alpha', 'turn-launch');
	const busy = await grokTurn('alpha', 'turn-launch');
	expect(await grokNoticeHold('alpha', 'turn-launch')).toContain('recorded as busy');
	expect(await grokTurn('alpha', 'turn-launch')).toEqual(busy);
});

test.each([
	{ sessionId: 'another-thread' },
	{ subagentType: 'explore' },
	{ hook_event_name: 'Stop' },
	{ notificationType: 'permission_prompt' },
	{ timestamp: 'invalid' },
	{ timestamp: new Date(Date.now() + 60000).toISOString() },
	{ timestamp: '2020-01-01T00:00:00.000Z' },
])('unverified or stale native event cannot release a reserved wake: %j', async (extra) => {
	await reserveGrokNotice('alpha', 'turn-launch');
	await event(extra);
	expect(await grokNoticeAllowed('alpha', 'turn-launch')).toBe(false);
});

test('a new submit closes the gate even when the sidebar remains idle', async () => {
	await reserveGrokNotice('alpha', 'turn-launch');
	await event();
	await event({ hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE_SENTINEL' });
	expect(await grokNoticeAllowed('alpha', 'turn-launch')).toBe(false);
	expect(JSON.stringify(await grokTurn('alpha', 'turn-launch'))).not.toContain('PRIVATE');
});

test('continued tools close idle; definite-unsent rollback cannot undo newer provider evidence', async () => {
	const rollback = await reserveGrokNotice('alpha', 'turn-launch');
	await rollback();
	expect(await grokNoticeAllowed('alpha', 'turn-launch')).toBe(true);
	const older = await reserveGrokNotice('alpha', 'turn-launch');
	await grokInputSubmitted('alpha', 'turn-launch');
	await older();
	expect(await grokNoticeAllowed('alpha', 'turn-launch')).toBe(false);
	await event();
	await event({ hook_event_name: 'PreToolUse' });
	expect(await grokNoticeAllowed('alpha', 'turn-launch')).toBe(false);
});

test('receiver replacement retains the outstanding wake and rejects a different thread', async () => {
	await reserveGrokNotice('alpha', 'turn-launch');
	await initializeGrokTurn('alpha', 'turn-launch', 'native-thread');
	expect(await grokNoticeAllowed('alpha', 'turn-launch')).toBe(false);
	expect(initializeGrokTurn('alpha', 'turn-launch', 'another')).rejects.toThrow('another thread');
	await initializeGrokTurn('alpha', 'next-launch', 'native-thread');
	expect(await grokNoticeAllowed('alpha', 'next-launch')).toBe(true);
});

test('a busy observation at the same millisecond wins over idle and its repeated completion', async () => {
	await event();
	const timestamp = new Date((await grokTurn('alpha', 'turn-launch'))?.since ?? 0).toISOString();
	await observeGrokTurn('alpha', 'turn-launch', {
		sessionId: 'native-thread',
		hook_event_name: 'PreToolUse',
		timestamp,
	});
	await observeGrokTurn('alpha', 'turn-launch', {
		sessionId: 'native-thread',
		hook_event_name: 'Notification',
		notificationType: 'idle_prompt',
		timestamp,
	});
	expect((await grokTurn('alpha', 'turn-launch'))?.phase).toBe('busy');
});

test('invalid persisted observation refuses rather than allowing another write', async () => {
	await Bun.write(
		join(fixture.records, 'runtime/alpha/turn-launch.grok-turn'),
		'PRIVATE_CORRUPT',
	);
	expect(grokNoticeAllowed('alpha', 'turn-launch')).rejects.toThrow('Invalid Grok turn');
});
