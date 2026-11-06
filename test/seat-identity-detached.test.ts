import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { localEvents } from '../src/local-room.ts';
import { scrubSummonEnvironment } from '../src/unowned-command.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const originalRoot = process.env.SUMMON_HOME;

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	const runtime = join(fixture.records, 'runtime', 'alpha');
	await mkdir(runtime, { recursive: true });
	await writeFile(
		join(runtime, 'activity.json'),
		JSON.stringify({
			workingOn: '',
			state: 'idle',
			updatedAt: new Date().toISOString(),
			nonce: 'replacement-launch',
		}),
	);
});

afterEach(async () => {
	if (originalRoot === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = originalRoot;
	await fixture.dispose();
});

test('a replaced launch cannot post to Room or send mail as its former seat', async () => {
	const staleRoom = await fixture.run(['--room', 'send', 'stale post'], 'alpha');
	expect(staleRoom.code).toBe(1);
	expect(staleRoom.error).toContain('another launch');
	const staleMail = await fixture.run(['--mail', 'send-self', 'beta', 'stale message'], 'alpha');
	expect(staleMail.code).toBe(1);
	expect(staleMail.error).toContain('another launch');
	const staleBoard = await fixture.run(['--board', 'add', 'stale card'], 'alpha');
	expect(staleBoard.code).toBe(1);
	expect(staleBoard.error).toContain('another launch');
	const staleLauncher = await fixture.run(['--unowned', '--', 'bun', '--version'], 'alpha');
	expect(staleLauncher.code).toBe(1);
	expect(staleLauncher.error).toContain('another launch');
	expect(await localEvents()).toHaveLength(0);

	const live = { SUMMON_NONCE: 'replacement-launch' };
	expect((await fixture.run(['--room', 'send', 'live post'], 'alpha', live)).code).toBe(0);
	expect(
		(await fixture.run(['--mail', 'send-self', 'beta', 'live message'], 'alpha', live)).code,
	).toBe(0);
	expect((await localEvents()).map((event) => event.text)).toEqual(['live post']);
});

test('a missing activity record refuses named commands', async () => {
	await rm(join(fixture.records, 'runtime/alpha/activity.json'));
	const result = await fixture.run(['--room', 'send', 'unowned post'], 'alpha');
	expect(result.code).toBe(1);
	expect(result.error).toContain('another launch');
	expect(await localEvents()).toHaveLength(0);
});

test('unowned launch strips every seat variable from child and descendant', async () => {
	expect(
		scrubSummonEnvironment({
			SUMMON_AGENT: 'alpha',
			sUmMoN_nonce: 'old',
			SUMMON_CLAUDE_TURN_KEY: 'not-a-real-key',
			KEEP_SETTING: 'kept',
		}),
	).toEqual({ KEEP_SETTING: 'kept' });
	const child = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, '../src/cli.ts'),
			'--unowned',
			'--',
			process.execPath,
			join(import.meta.dir, 'fixtures/unowned-observe.ts'),
		],
		{
			cwd: fixture.root,
			env: {
				...process.env,
				SUMMON_HOME: fixture.records,
				SUMMON_AGENT: 'alpha',
				SUMMON_NONCE: 'replacement-launch',
				SUMMON_CLAUDE_TURN_URL: 'http://invalid.example',
				SUMMON_CLAUDE_TURN_KEY: 'not-a-real-key',
				KEEP_SETTING: 'kept',
			},
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
		},
	);
	const [out, error, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(error).toBe('');
	expect(code).toBe(0);
	const observed: unknown = JSON.parse(out);
	expect(observed).toEqual({ direct: [], descendant: [], keep: 'kept' });
});

test('ordinary operator Room path remains available', async () => {
	expect((await fixture.run(['--msg', 'operator post'])).code).toBe(0);
	expect((await localEvents()).map((event) => event.text)).toEqual(['operator post']);
});
