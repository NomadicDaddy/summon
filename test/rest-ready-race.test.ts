import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

import { initializeActivity, readActivity, setOwnActivity } from '../src/agent-activity.ts';
import { providers } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

// The checked evidence is taken first; `between` then runs where a concurrent same-launch status
// write would land, before rest ready's idle write.
let between: () => Promise<void> = () => Promise.resolve();
await mock.module('../src/rest-evidence.ts', () => ({
	restEvidence: async (name: string) => {
		const activity = await readActivity(name);
		await between();
		return {
			board: '{"cards":[],"decisions":[]}',
			through: 0,
			reason: '',
			nonce: activity?.nonce,
			activitySnapshot: activity === undefined ? undefined : JSON.stringify(activity),
		};
	},
}));
const { restCommand } = await import('../src/rest.ts');

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const saved = { ...process.env };
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = 'test-launch';
	between = () => Promise.resolve();
});
afterEach(async () => {
	process.env = { ...saved };
	await fixture.dispose();
});

const restFile = () => fixture.read('runtime/alpha/rest.json').catch(() => undefined);
/** The refusal message from rest ready, or '' when it succeeded. */
const restReady = () =>
	restCommand(['ready']).then(
		() => '',
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);

for (const provider of providers) {
	test(`${provider}: a busy status written after the check survives and rest is not confirmed`, async () => {
		await initializeActivity('alpha', 'test-launch', provider);
		await setOwnActivity('alpha', 'busy', 'Old task');
		between = async () => {
			between = () => Promise.resolve();
			await setOwnActivity('alpha', 'busy', 'New task');
		};
		expect(await restReady()).toContain('your status changed while rest was being checked');
		expect(await readActivity('alpha')).toMatchObject({ state: 'busy', workingOn: 'New task' });
		expect(await restFile()).toBeUndefined();
	});
}

test('the injected write survives byte for byte and no rest is recorded', async () => {
	await initializeActivity('alpha', 'test-launch', 'claude');
	await setOwnActivity('alpha', 'busy', 'Old task');
	let afterInjection = '';
	between = async () => {
		between = () => Promise.resolve();
		await setOwnActivity('alpha', 'busy', 'New task');
		afterInjection = await fixture.read('runtime/alpha/activity.json');
	};
	expect(await restReady()).toContain('your status changed');
	expect(await fixture.read('runtime/alpha/activity.json')).toBe(afterInjection);
	expect(await readActivity('alpha')).toMatchObject({ state: 'busy', workingOn: 'New task' });
	expect(await restFile()).toBeUndefined();
});

test('a needs-user hand raised after the check is kept', async () => {
	await initializeActivity('alpha', 'test-launch', 'codex');
	await setOwnActivity('alpha', 'busy', 'Old task');
	between = async () => {
		between = () => Promise.resolve();
		await setOwnActivity('alpha', 'needs-user', 'Approval needed');
	};
	expect(await restReady()).toContain('your status changed');
	expect(await readActivity('alpha')).toMatchObject({
		state: 'needs-user',
		workingOn: 'Approval needed',
	});
	expect(await restFile()).toBeUndefined();
});

test('with no write in between, rest ready sets idle Ready and confirms', async () => {
	await initializeActivity('alpha', 'test-launch', 'grok');
	await setOwnActivity('alpha', 'busy', 'Old task');
	expect(await restReady()).toBe('');
	expect(await readActivity('alpha')).toMatchObject({ state: 'idle', workingOn: 'Ready' });
	expect(JSON.parse((await restFile()) ?? '{}')).toMatchObject({ mode: 'ready' });
});

test('a changed human wait after evidence is preserved without confirming stale consent', async () => {
	await initializeActivity('alpha', 'test-launch', 'codex');
	await setOwnActivity('alpha', 'needs-user', 'First approval');
	let changed = '';
	between = async () => {
		between = () => Promise.resolve();
		await setOwnActivity('alpha', 'needs-user', 'Another approval');
		changed = await fixture.read('runtime/alpha/activity.json');
	};
	expect(await restReady()).toContain('your status changed');
	expect(await fixture.read('runtime/alpha/activity.json')).toBe(changed);
	expect(await restFile()).toBeUndefined();
});
