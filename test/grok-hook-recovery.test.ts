import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { installGrokTurnHooks } from '../src/grok-turn-hooks.ts';
import { acquireSessionLock, type SessionLock } from '../src/session-lock.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let lock: SessionLock | undefined;
let home: string;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	home = join(fixture.root, 'grok');
});
afterEach(async () => {
	await lock?.release();
	lock = undefined;
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});
const hooks = (): Promise<string[]> => readdir(join(home, 'hooks'));
const leasePath = (): string => join(fixture.records, 'runtime', 'alpha', 'grok-hook-lease.json');
async function takeLock() {
	lock = await acquireSessionLock('alpha');
	if (!lock) throw new Error('Expected disposable session lock.');
	return lock;
}
async function rejection(operation: Promise<unknown>, message = '') {
	const result = await operation.then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(result).toBeInstanceOf(Error);
	if (result instanceof Error) expect(result.message).toContain(message);
}

test('hook installation requires a session lock and cannot replace the same live launch', async () => {
	await rejection(installGrokTurnHooks('alpha', 'old', 'thread', home), 'owned session lock');
	await takeLock();
	const cleanup = await installGrokTurnHooks('alpha', 'old', 'thread', home);
	await rejection(installGrokTurnHooks('alpha', 'new', 'thread', home), 'already owns');
	expect(await hooks()).toHaveLength(1);
	await cleanup();
	expect(await hooks()).toHaveLength(0);
	expect(await Bun.file(leasePath()).exists()).toBe(false);
});

test('recovery preserves other owners and human edits; late cleanup cannot remove a new lease', async () => {
	await takeLock();
	const lateCleanup = await installGrokTurnHooks('alpha', 'old', 'thread', home);
	const [old] = await hooks();
	if (!old) throw new Error('Expected old hook.');
	await writeFile(join(home, 'hooks', old), 'HUMAN_EDIT');
	await writeFile(join(home, 'hooks', 'summon-turn-other-owner.json'), 'OTHER_OWNER');
	await lock?.release();
	await takeLock();
	const cleanup = await installGrokTurnHooks('alpha', 'new', 'thread', home);
	expect(await hooks()).toHaveLength(3);
	const currentLease = await readFile(leasePath(), 'utf8');
	await lateCleanup();
	expect(await readFile(leasePath(), 'utf8')).toBe(currentLease);
	await cleanup();
	expect(await readFile(join(home, 'hooks', old), 'utf8')).toBe('HUMAN_EDIT');
	expect(await readFile(join(home, 'hooks', 'summon-turn-other-owner.json'), 'utf8')).toBe(
		'OTHER_OWNER',
	);
	expect(await hooks()).toHaveLength(2);
});

test('interrupted publication and a changed Grok home fail closed without removing files', async () => {
	await takeLock();
	await installGrokTurnHooks('alpha', 'old', 'thread', home);
	const journal = JSON.parse(await readFile(leasePath(), 'utf8')) as Record<string, unknown>;
	await writeFile(leasePath(), JSON.stringify({ ...journal, phase: 'prepared' }));
	await lock?.release();
	await takeLock();
	await rejection(
		installGrokTurnHooks('alpha', 'new', 'thread', home),
		'publication was interrupted',
	);
	expect(await hooks()).toHaveLength(1);
	await writeFile(leasePath(), JSON.stringify(journal));
	await rejection(
		installGrokTurnHooks('alpha', 'new', 'thread', join(fixture.root, 'elsewhere')),
		'home changed',
	);
	expect(await hooks()).toHaveLength(1);
});

test('an old unrecorded hook is never swept or adopted as owned', async () => {
	await mkdir(join(home, 'hooks'), { recursive: true });
	await writeFile(join(home, 'hooks', 'summon-turn-unrecorded.json'), 'UNRECORDED');
	await takeLock();
	const cleanup = await installGrokTurnHooks('alpha', 'new', 'thread', home);
	await cleanup();
	expect(await hooks()).toEqual(['summon-turn-unrecorded.json']);
});

test('an interrupted reservation without a hook is recoverable, while corrupt ownership is retained', async () => {
	await takeLock();
	await installGrokTurnHooks('alpha', 'old', 'thread', home);
	const journal = JSON.parse(await readFile(leasePath(), 'utf8')) as Record<string, unknown>;
	const [old] = await hooks();
	if (!old) throw new Error('Expected old hook.');
	await writeFile(leasePath(), JSON.stringify({ ...journal, phase: 'prepared' }));
	await unlink(join(home, 'hooks', old));
	await lock?.release();
	await takeLock();
	const cleanup = await installGrokTurnHooks('alpha', 'new', 'thread', home);
	expect(await hooks()).toHaveLength(1);
	await cleanup();
	await writeFile(leasePath(), '{broken');
	await rejection(
		installGrokTurnHooks('alpha', 'last', 'thread', home),
		'Invalid Grok hook ownership',
	);
	expect(await readFile(leasePath(), 'utf8')).toBe('{broken');
	await writeFile(leasePath(), '');
	await rejection(
		installGrokTurnHooks('alpha', 'last', 'thread', home),
		'Invalid Grok hook ownership',
	);
	expect(await readFile(leasePath(), 'utf8')).toBe('');
	expect(await hooks()).toHaveLength(0);
});

test('a same-name edited hook collision is preserved and never left claimed by the failed install', async () => {
	await takeLock();
	await installGrokTurnHooks('alpha', 'same-nonce', 'thread', home);
	const [old] = await hooks();
	if (!old) throw new Error('Expected old hook.');
	await writeFile(join(home, 'hooks', old), 'HUMAN_EDIT');
	await lock?.release();
	await takeLock();
	await rejection(installGrokTurnHooks('alpha', 'same-nonce', 'thread', home));
	expect(await readFile(join(home, 'hooks', old), 'utf8')).toBe('HUMAN_EDIT');
	expect(await Bun.file(leasePath()).exists()).toBe(false);
});

test('a killed hook owner is recovered only after its surviving provider exits', async () => {
	// This is a disposable Bun process, never a native provider.
	const survivor = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(60000)'], {
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'ignore',
		windowsHide: true,
	});
	const owner = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, 'fixtures/grok-hook-owner.ts'),
			home,
			String(survivor.pid),
		],
		{
			env: { ...process.env, SUMMON_HOME: fixture.records },
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
		},
	);
	try {
		const reader = owner.stdout.getReader();
		const ready = await reader.read();
		expect(new TextDecoder().decode(ready.value)).toContain('HOOK_READY');
		reader.releaseLock();
		expect(await acquireSessionLock('alpha')).toBeUndefined();
		owner.kill(9);
		await owner.exited;
		expect(await hooks()).toHaveLength(1);
		expect(await acquireSessionLock('alpha')).toBeUndefined();
		survivor.kill(9);
		await survivor.exited;
		await takeLock();
		const cleanup = await installGrokTurnHooks('alpha', 'new', 'new-thread', home);
		expect(await hooks()).toHaveLength(1);
		const [newHook] = await hooks();
		if (!newHook) throw new Error('Expected replacement hook.');
		expect(await readFile(join(home, 'hooks', newHook), 'utf8')).toContain('new-thread');
		await cleanup();
		expect(await hooks()).toHaveLength(0);
	} finally {
		if (owner.exitCode === null) owner.kill(9);
		if (survivor.exitCode === null) survivor.kill(9);
		await Promise.all([owner.exited, survivor.exited]);
	}
}, 20000);
