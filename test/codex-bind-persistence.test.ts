import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { locked } from '../src/mail-files.ts';
import { bindSession } from '../src/mail-session-hook.ts';
import { saveDelivery } from '../src/mail-session.ts';
import { loadAgent, recordPath, rememberSession, updateAgentRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = {
	SUMMON_HOME: process.env.SUMMON_HOME,
	SUMMON_AGENT: process.env.SUMMON_AGENT,
	SUMMON_NONCE: process.env.SUMMON_NONCE,
};
const event = (id: string, source = 'startup') => ({
	hook_event_name: 'SessionStart',
	source,
	session_id: id,
});
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'beta';
	process.env.SUMMON_NONCE = 'test-launch';
	await updateAgentRecord('beta', (record) => {
		record.provider = 'codex';
	});
	await initializeActivity('beta', 'test-launch', 'codex');
	await saveDelivery('beta', {
		nonce: 'test-launch',
		pid: process.pid,
		state: 'queued-only',
		reason: '',
		thread: '',
	});
});
afterEach(async () => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) Reflect.deleteProperty(process.env, key);
		else process.env[key] = value;
	}
	await fixture.dispose();
});

test('fresh bind persists the exact conversation before returning and preserves the profile', async () => {
	await updateAgentRecord('beta', (record) => {
		record.domain = 'Operator-owned domain';
		record.modelInfo = {
			provider: 'codex',
			sessionId: 'earlier-thread',
			model: 'operator-model',
			observedAt: new Date().toISOString(),
		};
		record.hibernation = {
			active: false,
			revision: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
			changedAt: 1,
		};
	});
	const before = await loadAgent('beta');
	await bindSession(event('native-exact-thread'));
	const saved = await loadAgent('beta');
	expect(saved?.sessions.map(({ id }) => id)).toEqual(['native-exact-thread']);
	expect(saved).toMatchObject({
		domain: before?.domain,
		modelInfo: before?.modelInfo,
		cwd: before?.cwd,
		expertise: before?.expertise,
		hibernation: before?.hibernation,
	});
	expect(await fixture.read('runtime/beta/test-launch.binding')).toBe('native-exact-thread');
});

test('resume is idempotent and clear saves the new conversation immediately', async () => {
	await updateAgentRecord('beta', (record) => {
		rememberSession(record, 'resumed-thread');
	});
	await saveDelivery('beta', {
		nonce: 'test-launch',
		pid: process.pid,
		state: 'queued-only',
		reason: '',
		thread: 'resumed-thread',
	});
	await bindSession(event('resumed-thread', 'resume'));
	await bindSession(event('resumed-thread', 'resume'));
	expect((await loadAgent('beta'))?.sessions).toHaveLength(1);
	await bindSession(event('cleared-thread', 'clear'));
	await bindSession(event('cleared-thread'));
	expect((await loadAgent('beta'))?.sessions.map(({ id }) => id)).toEqual([
		'resumed-thread',
		'cleared-thread',
	]);
	expect(await fixture.read('runtime/beta/test-launch.binding')).toBe('cleared-thread');
});

test('stale launches, foreign threads and invalid IDs cannot rewrite saved history', async () => {
	await bindSession(event('native-exact-thread'));
	const before = await fixture.read('beta.json');
	expect(await bindSession(event('foreign-thread')).catch(String)).toContain('does not match');
	expect(await bindSession(event('--invalid')).catch(String)).toContain('Invalid session ID');
	await initializeActivity('beta', 'replacement-launch', 'codex');
	expect(await bindSession(event('stale-clear', 'clear')).catch(String)).toContain(
		'current launch',
	);
	expect(await fixture.read('beta.json')).toBe(before);
	expect(await fixture.read('runtime/beta/test-launch.binding')).toBe('native-exact-thread');
});

test('non-Codex profiles and subagents cannot create a Codex binding', async () => {
	await updateAgentRecord('beta', (record) => {
		record.provider = 'claude';
	});
	const before = await fixture.read('beta.json');
	await bindSession({ ...event('subagent-thread'), agent_id: 'child' });
	expect(await bindSession(event('wrong-provider')).catch(String)).toContain('registered Codex');
	expect(await fixture.read('beta.json')).toBe(before);
	expect(await Bun.file(join(fixture.records, 'runtime/beta/test-launch.binding')).exists()).toBe(
		false,
	);
});

test('binding reloads the profile under the writer lock instead of losing concurrent operator edits', async () => {
	let binding: Promise<void> | undefined;
	await locked(`${recordPath('beta')}.write-lock`, async () => {
		binding = bindSession(event('native-exact-thread'));
		const record = await loadAgent('beta');
		if (!record) throw new Error('Missing fixture profile.');
		record.expertise = 'Concurrent operator edit';
		await Bun.write(recordPath('beta'), JSON.stringify(record));
	});
	await binding;
	expect((await loadAgent('beta'))?.expertise).toBe('Concurrent operator edit');
	expect((await loadAgent('beta'))?.sessions.at(-1)?.id).toBe('native-exact-thread');
});

test('a provider change while binding waits on the profile lock refuses both publications', async () => {
	let binding: Promise<void> | undefined;
	await locked(`${recordPath('beta')}.write-lock`, async () => {
		binding = bindSession(event('native-exact-thread'));
		const record = await loadAgent('beta');
		if (!record) throw new Error('Missing fixture profile.');
		record.provider = 'kilo';
		await Bun.write(recordPath('beta'), JSON.stringify(record));
	});
	expect(await binding?.catch(String)).toContain('registered Codex');
	expect((await loadAgent('beta'))?.sessions).toEqual([]);
	expect(await Bun.file(join(fixture.records, 'runtime/beta/test-launch.binding')).exists()).toBe(
		false,
	);
});

test('a failed profile save is not published as a successful binding', async () => {
	await Bun.write(recordPath('beta'), '{');
	expect(await bindSession(event('native-exact-thread')).catch(String)).toContain('JSON');
	expect(await fixture.read('beta.json')).toBe('{');
	expect(await Bun.file(join(fixture.records, 'runtime/beta/test-launch.binding')).exists()).toBe(
		false,
	);
});

test('a different provider launch refuses binding even if the profile still says Codex', async () => {
	await initializeActivity('beta', 'test-launch', 'grok');
	expect(await bindSession(event('wrong-launch-provider')).catch(String)).toContain(
		'current launch',
	);
	expect((await loadAgent('beta'))?.sessions).toEqual([]);
});
