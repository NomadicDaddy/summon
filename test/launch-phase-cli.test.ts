import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ownedLaunchNonce } from '../src/launch-phase-command.ts';
import { cliHarness } from './fixtures/cli-harness.ts';

let fixture: Awaited<ReturnType<typeof cliHarness>>;
beforeEach(async () => {
	fixture = await cliHarness();
});
afterEach(async () => {
	await fixture.dispose();
});

for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const) {
	test(`${provider} owned runner consumes parent nonce without forwarding it to the provider`, async () => {
		await fixture.seed(provider);
		const nonce = randomUUID();
		const args = [
			'__session',
			'member',
			'--storage-root',
			fixture.records,
			'--launch-nonce',
			nonce,
			...(provider === 'claude' ? ['--claude-checkpoint'] : []),
		];
		// This control inspects spawn identity before a provider SessionStart observation.
		// The persistence fixture now calls the real binding consumer when enabled.
		const result = await fixture.invoke(args, {
			AIDD_AGENT: '',
			SUMMON_TEST_CODEX_NO_BINDING: '1',
		});
		expect(result.code).toBe(0);
		const activity: unknown = await Bun.file(
			join(fixture.records, 'runtime/member/activity.json'),
		).json();
		expect(activity).toMatchObject({
			nonce,
			state: 'idle',
			workingOn: '',
			launch: { phase: 'connecting', provider, evidence: 'owned-process-spawn' },
		});
		expect(result.launches).not.toHaveLength(0);
		expect(result.launches.find((launch) => launch.cmd[0] === provider)?.agentGuard).toBe('1');
		for (const launch of result.launches) expect(launch.cmd).not.toContain('--launch-nonce');
		const prompt = await Bun.file(
			join(
				fixture.records,
				'runtime/member',
				provider === 'kilo' ? 'kilo-instructions.md' : 'session-prompt.md',
			),
		).text();
		expect(prompt).toContain(
			'Before historical mailbox catch-up, complete current-launch readiness and set summon --status',
		);
		expect(prompt).toContain('Readiness is transport confirmation');
		expect(prompt).toContain('Launch mode: resume.');
		if (provider === 'grok') {
			expect(await readdir(join(fixture.root, 'grok/hooks'))).toEqual([]);
			expect(
				await Bun.file(join(fixture.records, `runtime/member/${nonce}.grok-turn`)).json(),
			).toMatchObject({
				nonce,
				thread: 'existing-session',
				phase: 'unknown',
				bootstrapUsed: false,
			});
		}
	});
}

for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const) {
	test(`${provider} writes fresh launch mode before remembering its new conversation`, async () => {
		const record = await fixture.seed(provider);
		record.sessions = [];
		await writeFile(join(fixture.records, 'member.json'), JSON.stringify(record));
		const result = await fixture.invoke([
			'__session',
			'member',
			'--storage-root',
			fixture.records,
			'--launch-nonce',
			randomUUID(),
			...(provider === 'claude' ? ['--claude-checkpoint'] : []),
		]);
		expect(result.code).toBe(0);
		const prompt = await Bun.file(
			join(
				fixture.records,
				'runtime/member',
				provider === 'kilo' ? 'kilo-instructions.md' : 'session-prompt.md',
			),
		).text();
		expect(prompt).toContain('Launch mode: fresh.');
		expect(prompt).toContain('A note from an earlier session.');
	});
}

test('unavailable Grok hook directory reports queued fallback without aborting owned startup', async () => {
	await fixture.seed('grok');
	const home = join(fixture.root, 'unavailable-grok-home');
	await writeFile(home, 'NON_DIRECTORY_CONTROL');
	const result = await fixture.invoke(
		['__session', 'member', '--storage-root', fixture.records, '--launch-nonce', randomUUID()],
		{ GROK_HOME: home },
	);
	expect(result.code).toBe(0);
	expect(result.stderr).toContain('ordinary notices remain queued');
	expect(result.launches.some((launch) => launch.cmd[0] === 'grok')).toBe(true);
	expect(await Bun.file(home).text()).toBe('NON_DIRECTORY_CONTROL');
});

test('malformed or duplicate parent identities fail before provider spawn', async () => {
	await fixture.seed('codex');
	for (const tail of [
		['--launch-nonce'],
		['--launch-nonce', 'not-a-uuid'],
		['--launch-nonce', randomUUID(), '--launch-nonce', randomUUID()],
	]) {
		const result = await fixture.invoke(['__session', 'member', ...tail]);
		expect(result.code).toBe(1);
		expect(result.launches).toEqual([]);
	}
	expect(ownedLaunchNonce(['__session', 'member']).nonce).toBeUndefined();
});
