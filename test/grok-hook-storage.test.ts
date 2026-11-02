import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { installGrokTurnHooks } from '../src/grok-turn-hooks.ts';
import { grokTurn, observeGrokTurn } from '../src/grok-turn-state.ts';
import { acquireSessionLock, type SessionLock } from '../src/session-lock.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let lock: SessionLock | undefined;
const previous = {
	SUMMON_HOME: process.env.SUMMON_HOME,
	SUMMON_TEAMS_HOME: process.env.SUMMON_TEAMS_HOME,
};
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	delete process.env.SUMMON_TEAMS_HOME;
});
afterEach(async () => {
	await lock?.release();
	lock = undefined;
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) Reflect.deleteProperty(process.env, key);
		else process.env[key] = value;
	}
	await fixture.dispose();
});

async function hook(root: string, nonce: string, base?: string) {
	const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/grok-turn-hook.ts')], {
		env: {
			...process.env,
			SUMMON_HOME: root,
			SUMMON_TEAMS_HOME: base,
			SUMMON_AGENT: 'alpha',
			SUMMON_NONCE: nonce,
			SUMMON_GROK_SESSION: 'resumed-thread',
		},
		stdin: new TextEncoder().encode(
			JSON.stringify({
				sessionId: 'resumed-thread',
				hook_event_name: 'Notification',
				notificationType: 'idle_prompt',
				timestamp: new Date().toISOString(),
				message: 'PRIVATE_MUST_NOT_PERSIST',
			}),
		),
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	});
	const [code, out, error] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(code).toBe(0);
	expect(out).toBe('');
	expect(error).not.toContain('PRIVATE');
	return error;
}

async function install(nonce: string) {
	lock = await acquireSessionLock('alpha');
	if (!lock) throw new Error('Missing disposable session lock.');
	return installGrokTurnHooks('alpha', nonce, 'resumed-thread', join(fixture.root, 'grok'));
}

test('an obsolete hook selecting the teams base cannot recreate runtime', async () => {
	const base = join(fixture.root, 'base');
	await mkdir(join(base, 'team-default'), { recursive: true });
	await hook(base, 'old-launch', base);
	expect(await readdir(base)).toEqual(['team-default']);
});

test('missing launch observation never creates a runtime tree, including direct observer calls', async () => {
	const root = join(fixture.root, 'removed-store');
	await hook(root, 'old-launch');
	expect(await Bun.file(join(root, 'runtime/alpha/old-launch.grok-turn')).exists()).toBe(false);
	process.env.SUMMON_HOME = root;
	await observeGrokTurn('alpha', 'old-launch', { sessionId: 'resumed-thread' });
	expect(await readdir(fixture.root)).not.toContain('removed-store');
});

test('only the current owned launch may observe a resumed conversation', async () => {
	await install('old-launch');
	await lock?.release();
	const cleanup = await install('current-launch');
	const oldState = await grokTurn('alpha', 'old-launch');
	await hook(fixture.records, 'old-launch');
	expect(await grokTurn('alpha', 'old-launch')).toEqual(oldState);
	expect(await hook(fixture.records, 'current-launch')).toBe('');
	expect((await grokTurn('alpha', 'current-launch'))?.phase).toBe('idle');
	expect(JSON.stringify(await grokTurn('alpha', 'current-launch'))).not.toContain('PRIVATE');
	await cleanup();
});

test('a released session lock cannot authorize its retained launch hook', async () => {
	const cleanup = await install('old-launch');
	const state = await grokTurn('alpha', 'old-launch');
	await lock?.release();
	await hook(fixture.records, 'old-launch');
	expect(await grokTurn('alpha', 'old-launch')).toEqual(state);
	await cleanup();
});

test.each(['prepared', 'wrong-root', 'corrupt'])(
	'an unusable lease cannot authorize a write: %s',
	async (kind) => {
		const cleanup = await install('current-launch');
		const path = join(fixture.records, 'runtime/alpha/grok-hook-lease.json');
		const original = await readFile(path, 'utf8');
		const lease = JSON.parse(original) as Record<string, unknown>;
		if (kind === 'prepared') lease.phase = 'prepared';
		if (kind === 'wrong-root') lease.root = join(fixture.root, 'another-store');
		const state = await grokTurn('alpha', 'current-launch');
		await writeFile(path, kind === 'corrupt' ? '{broken' : JSON.stringify(lease));
		await hook(fixture.records, 'current-launch');
		expect(await grokTurn('alpha', 'current-launch')).toEqual(state);
		await writeFile(path, original);
		await cleanup();
	},
);

for (const [legacy, edited] of [
	[false, false],
	[true, false],
	[true, true],
] as const) {
	test(`a moved lease (legacy=${legacy}, edited=${edited}) recovers only its unchanged old hook`, async () => {
		await install('old-launch');
		const home = join(fixture.root, 'grok');
		const [oldHook] = await readdir(join(home, 'hooks'));
		if (!oldHook) throw new Error('Missing old hook control.');
		if (edited) await writeFile(join(home, 'hooks', oldHook), 'HUMAN_REPLACEMENT');
		const oldRoot = fixture.records;
		if (legacy) {
			const path = join(oldRoot, 'runtime/alpha/grok-hook-lease.json');
			const lease = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
			delete lease.root;
			await writeFile(path, JSON.stringify(lease));
		}
		await writeFile(join(home, 'hooks/user.json'), 'UNRELATED_HOOK');
		await lock?.release();
		const root = join(oldRoot, 'team-default');
		await mkdir(root);
		await rename(join(oldRoot, 'runtime'), join(root, 'runtime'));
		process.env.SUMMON_HOME = root;
		process.env.SUMMON_TEAMS_HOME = oldRoot;
		const cleanup = await install('current-launch');
		expect((await readdir(join(home, 'hooks'))).includes(oldHook)).toBe(edited);
		expect(await readFile(join(home, 'hooks/user.json'), 'utf8')).toBe('UNRELATED_HOOK');
		await cleanup();
		expect((await readdir(join(home, 'hooks'))).sort()).toEqual(
			edited ? [oldHook, 'user.json'].sort() : ['user.json'],
		);
		if (edited)
			expect(await readFile(join(home, 'hooks', oldHook), 'utf8')).toBe('HUMAN_REPLACEMENT');
	});
}
