import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { sessionPrompt } from '../src/providers.ts';
import { newRecord } from '../src/store.ts';
import { cliHarness } from './fixtures/cli-harness.ts';

let fixture: Awaited<ReturnType<typeof cliHarness>>;
beforeEach(async () => {
	fixture = await cliHarness();
});
afterEach(async () => {
	await fixture.dispose();
});

const promptPath = (provider: string) =>
	join(
		fixture.records,
		'runtime/member',
		provider === 'kilo' ? 'kilo-instructions.md' : 'session-prompt.md',
	);

function launch(nonce: string, provider: string) {
	return fixture.invoke(
		[
			'__session',
			'member',
			'--storage-root',
			fixture.records,
			'--launch-nonce',
			nonce,
			...(provider === 'claude' ? ['--claude-checkpoint'] : []),
		],
		{ AIDD_AGENT: '', SUMMON_TEST_CODEX_NO_BINDING: '1' },
	);
}

for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const) {
	test(`${provider} prompt names the ready command for the nonce the launch runs under`, async () => {
		await fixture.seed(provider);
		const nonce = randomUUID();
		const result = await launch(nonce, provider);
		expect(result.code).toBe(0);
		const prompt = await Bun.file(promptPath(provider)).text();
		expect(prompt).toContain(`This launch's readiness command: summon --mail ready ${nonce}\n`);
		// The same identity the checker compares: the child's SUMMON_NONCE and the activity record.
		const spawned = result.launches.find((entry) => entry.cmd[0] === provider);
		expect(spawned?.summonNonce).toBe(nonce);
		const activity = (await Bun.file(
			join(fixture.records, 'runtime/member/activity.json'),
		).json()) as { nonce: string };
		expect(activity.nonce).toBe(nonce);
		// Never the provider thread id, which the fixture records as existing-session.
		expect(prompt).not.toContain('summon --mail ready existing-session');
		expect(prompt).toContain(
			'Readiness confirms transport only, never approval or task completion.',
		);
	});
}

test('a relaunch publishes its own nonce, and the earlier command is refused without changing identity', async () => {
	await fixture.seed('codex');
	const first = randomUUID();
	const second = randomUUID();
	expect((await launch(first, 'codex')).code).toBe(0);
	expect((await launch(second, 'codex')).code).toBe(0);
	const prompt = await Bun.file(promptPath('codex')).text();
	expect(prompt).toContain(`summon --mail ready ${second}\n`);
	expect(prompt).not.toContain(first);

	const stale = await fixture.invoke(['--mail', 'ready', first], {
		SUMMON_AGENT: 'member',
		SUMMON_NONCE: second,
	});
	expect(stale.code).toBe(1);
	expect(stale.stderr).toContain('Readiness nonce does not match this session.');
	expect(await Bun.file(join(fixture.records, `runtime/member/${first}.ready`)).exists()).toBe(
		false,
	);
	expect(await Bun.file(join(fixture.records, `runtime/member/${second}.ready`)).exists()).toBe(
		false,
	);
	const activity = (await Bun.file(
		join(fixture.records, 'runtime/member/activity.json'),
	).json()) as { nonce: string };
	expect(activity.nonce).toBe(second);
});

test('a prompt built without a launch carries no readiness command', () => {
	const prompt = sessionPrompt(newRecord('Member', '.', 'claude'), 'member', '', [], 'mailbox');
	expect(prompt).not.toContain('summon --mail ready ');
	expect(prompt).not.toContain("This launch's readiness command");
});
