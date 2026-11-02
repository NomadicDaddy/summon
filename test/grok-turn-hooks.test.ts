import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { grokTurnHooks, installGrokTurnHooks } from '../src/grok-turn-hooks.ts';
import { grokTurn, reserveGrokNotice } from '../src/grok-turn-state.ts';
import { acquireSessionLock, type SessionLock } from '../src/session-lock.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let sessionLock: SessionLock | undefined;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	sessionLock = await acquireSessionLock('alpha');
	if (!sessionLock) throw new Error('Missing test session lock.');
});
afterEach(async () => {
	await sessionLock?.release();
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

test('launch hook configuration is local, exact-session and excludes Stop gates', () => {
	const config = grokTurnHooks('alpha', 'turn-launch', 'native-thread');
	expect(Object.keys(config.hooks).sort()).toEqual([
		'Notification',
		'PostCompact',
		'PreCompact',
		'PreToolUse',
		'UserPromptSubmit',
	]);
	expect(config.hooks.Notification[0]?.matcher).toBe('^idle_prompt$');
	const env = config.hooks.Notification[0]?.hooks[0]?.env;
	expect(env?.SUMMON_NONCE).toBe('turn-launch');
	expect(env?.SUMMON_GROK_SESSION).toBe('native-thread');
	expect(JSON.stringify(config)).not.toContain('http');
});

test('unique owned hook cleanup preserves user hooks and a concurrent human replacement', async () => {
	const home = join(fixture.root, 'grok');
	await mkdir(join(home, 'hooks'), { recursive: true });
	const user = join(home, 'hooks/user.json');
	await writeFile(user, 'USER_HOOK_CONTROL');
	const cleanup = await installGrokTurnHooks('alpha', 'turn-launch', 'native-thread', home);
	const owned = (await readdir(join(home, 'hooks'))).find((name) =>
		name.startsWith('summon-turn-'),
	);
	if (!owned) throw new Error('Missing owned hook control.');
	await writeFile(join(home, 'hooks', owned), 'HUMAN_REPLACEMENT');
	await cleanup();
	expect(await Bun.file(user).text()).toBe('USER_HOOK_CONTROL');
	expect(await Bun.file(join(home, 'hooks', owned)).text()).toBe('HUMAN_REPLACEMENT');
});

test('normal cleanup removes only its unchanged launch file', async () => {
	const home = join(fixture.root, 'grok');
	const cleanup = await installGrokTurnHooks('alpha', 'turn-launch', 'native-thread', home);
	expect(await readdir(join(home, 'hooks'))).toHaveLength(1);
	await cleanup();
	expect(await readdir(join(home, 'hooks'))).toHaveLength(0);
});

test('hook entry consumes only its exact provider session, without storing prompt text', async () => {
	const home = join(fixture.root, 'grok');
	const cleanup = await installGrokTurnHooks('alpha', 'turn-launch', 'native-thread', home);
	await reserveGrokNotice('alpha', 'turn-launch');
	try {
		await Bun.sleep(5);
		const hook = grokTurnHooks('alpha', 'turn-launch', 'native-thread').hooks.Notification[0]
			?.hooks[0];
		if (!hook) throw new Error('Missing hook command control.');
		const command =
			process.platform === 'win32'
				? [
						'pwsh',
						'-NoProfile',
						'-NonInteractive',
						'-EncodedCommand',
						hook.command.split(' ').at(-1) ?? '',
					]
				: ['sh', '-c', hook.command];
		const child = Bun.spawn(command, {
			env: { ...process.env, ...hook.env },
			stdin: new TextEncoder().encode(
				JSON.stringify({
					sessionId: 'native-thread',
					hook_event_name: 'Notification',
					notificationType: 'idle_prompt',
					timestamp: new Date().toISOString(),
					message: 'PRIVATE_HOOK_CONTROL',
				}),
			),
			stdout: 'pipe',
			stderr: 'pipe',
		});
		expect(await child.exited).toBe(0);
		expect(await new Response(child.stdout).text()).toBe('');
		expect(await new Response(child.stderr).text()).toBe('');
		expect((await grokTurn('alpha', 'turn-launch'))?.phase).toBe('idle');
		expect(JSON.stringify(await grokTurn('alpha', 'turn-launch'))).not.toContain('PRIVATE');
	} finally {
		await cleanup();
	}
});
