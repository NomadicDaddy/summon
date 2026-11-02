import { afterEach, beforeEach, expect, test } from 'bun:test';

import { initializeActivity, readActivity } from '../src/agent-activity.ts';
import { ownedLaunchView } from '../src/desktop/launch-phase-view.ts';
import {
	launchReady,
	observeGrokSession,
	providerStarting,
	providerUp,
} from '../src/launch-phase.ts';
import { markReady, saveDelivery } from '../src/mail-session.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = { home: process.env.SUMMON_HOME, nonce: process.env.SUMMON_NONCE };
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_NONCE = 'test-launch';
});
afterEach(async () => {
	if (previous.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous.home;
	if (previous.nonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = previous.nonce;
	await fixture.dispose();
});

for (const [provider, evidence] of [
	['claude', 'claude-mcp-initialized'],
	['codex', 'codex-session-start'],
	['grok', 'grok-session-metadata'],
	['kilo', 'kilo-owned-session'],
] as const) {
	test(`${provider} phases never manufacture Busy or rewrite the quiet-period timestamp`, async () => {
		await initializeActivity('alpha', 'test-launch', provider);
		const initial = await readActivity('alpha');
		expect(initial?.launch?.phase).toBe('connecting');
		await providerUp('alpha', 'test-launch', provider, evidence);
		expect((await readActivity('alpha'))?.launch?.phase).toBe('logging-in');
		await saveDelivery('alpha', {
			nonce: 'test-launch',
			pid: process.pid,
			state: 'unconfirmed',
			reason: '',
			thread: 'fixture-session',
		});
		await markReady('alpha', 'test-launch');
		await providerUp('alpha', 'test-launch', provider, evidence);
		const startup = await readActivity('alpha');
		expect(startup?.launch?.phase).toBe('startup');
		expect(startup?.launch?.evidence).toBe('mail-readiness');
		expect(startup?.state).toBe('idle');
		expect(startup?.workingOn).toBe('');
		expect(startup?.updatedAt).toBe(initial?.updatedAt);
		const status = await fixture.run(['--status', 'idle', 'Ready'], 'alpha');
		expect(status.code).toBe(0);
		expect((await readActivity('alpha'))?.launch).toBeUndefined();
		await providerUp('alpha', 'test-launch', provider, evidence);
		await launchReady('alpha', 'test-launch');
		await providerStarting('alpha', 'test-launch', 'fixture-session');
		expect((await readActivity('alpha'))?.launch).toBeUndefined();
		expect((await readActivity('alpha'))?.workingOn).toBe('Ready');
	});
}

test('old nonces and invalid status cannot advance or finish a current launch', async () => {
	await initializeActivity('alpha', 'new-launch', 'codex');
	const before = await readActivity('alpha');
	await providerUp('alpha', 'test-launch', 'codex', 'codex-session-start');
	await launchReady('alpha', 'test-launch');
	await providerStarting('alpha', 'test-launch', 'old-session');
	expect((await fixture.run(['--status', 'busy', 'Old writer'], 'alpha')).code).toBe(1);
	expect(
		(
			await fixture.run(['--status', 'idle', 'x'.repeat(121)], 'alpha', {
				SUMMON_NONCE: 'new-launch',
			})
		).code,
	).toBe(1);
	expect(await readActivity('alpha')).toEqual(before);
	await providerUp('alpha', 'new-launch', 'claude', 'claude-mcp-initialized');
	expect(await readActivity('alpha')).toEqual(before);
	await initializeActivity('alpha', 'test-launch', 'codex');
	expect((await fixture.run(['--status', 'busy', 'Actual work'], 'alpha')).code).toBe(0);
	expect((await readActivity('alpha'))?.launch).toBeUndefined();
	expect((await readActivity('alpha'))?.state).toBe('busy');
});

test('Grok metadata requires the exact session and a strictly newer, nonfuture write', async () => {
	await initializeActivity('alpha', 'test-launch', 'grok');
	await providerStarting('alpha', 'test-launch', 'grok-owned');
	const before = await readActivity('alpha');
	const started = before?.launch?.providerStartedAt;
	if (!started) throw new Error('Missing provider spawn time.');
	await Bun.sleep(5);
	const info = {
		provider: 'grok' as const,
		sessionId: 'grok-owned',
		observedAt: new Date().toISOString(),
		model: 'fixture-model',
		source: 'provider-session' as const,
	};
	for (const candidate of [
		undefined,
		{ ...info, provider: 'codex' as const },
		{ ...info, sessionId: 'other-session' },
		{ ...info, observedAt: started },
		{ ...info, observedAt: 'invalid' },
		{ ...info, observedAt: '2099-01-01T00:00:00.000Z' },
	]) {
		await observeGrokSession('alpha', 'test-launch', candidate, () => true);
		expect(await readActivity('alpha')).toEqual(before);
	}
	await observeGrokSession('alpha', 'test-launch', info, () => true);
	expect((await readActivity('alpha'))?.launch?.phase).toBe('logging-in');
	await launchReady('alpha', 'test-launch');
	await observeGrokSession('alpha', 'test-launch', info, () => true);
	expect((await readActivity('alpha'))?.launch?.phase).toBe('startup');
});

test('renderer view exposes no provider identity and excludes the previous launch', async () => {
	const launch = { nonce: 'new-launch', since: new Date().toISOString() };
	await initializeActivity('alpha', 'test-launch', 'claude');
	expect(ownedLaunchView(launch, await readActivity('alpha'))).toEqual({
		phase: 'connecting',
		since: launch.since,
		evidence: 'owned-process-spawn',
	});
	await initializeActivity('alpha', 'new-launch', 'claude');
	await providerStarting('alpha', 'new-launch', 'private-provider-id');
	const view = ownedLaunchView(launch, await readActivity('alpha'));
	expect(Object.keys(view ?? {}).sort()).toEqual(['evidence', 'phase', 'since']);
	expect(JSON.stringify(view)).not.toContain('private-provider-id');
});

test('a status racing a late readiness observer stays complete under the activity lock', async () => {
	await initializeActivity('alpha', 'test-launch', 'kilo');
	const [status] = await Promise.all([
		fixture.run(['--status', 'busy', 'Resuming authorized work'], 'alpha'),
		launchReady('alpha', 'test-launch'),
		providerUp('alpha', 'test-launch', 'kilo', 'kilo-owned-session'),
	]);
	expect(status.code).toBe(0);
	expect(await readActivity('alpha')).toMatchObject({
		state: 'busy',
		workingOn: 'Resuming authorized work',
	});
	expect((await readActivity('alpha'))?.launch).toBeUndefined();
});
