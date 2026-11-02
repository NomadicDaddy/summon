import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { acquireSessionLock, isAgentRunning } from '../src/session-lock.ts';
import { newRecord, saveAgent } from '../src/store.ts';

let root: string;
const previous = process.env.SUMMON_HOME;
const children: ReturnType<typeof Bun.spawn>[] = [];

test.skipIf(process.platform !== 'win32')(
	'a reused live PID does not own an older session lock',
	async () => {
		const lock = await acquireSessionLock('test-agent');
		expect(lock).toBeDefined();
		const path = join(root, 'runtime/test-agent/session.lock/owner.json');
		await lock?.setChild(process.pid);
		const old = new Date('2000-01-01T00:00:00Z');
		await utimes(path, old, old);
		expect(await isAgentRunning('test-agent')).toBe(false);
		const replacement = await acquireSessionLock('test-agent');
		expect(replacement).toBeDefined();
		await lock?.release();
		expect(await isAgentRunning('test-agent')).toBe(true);
		await replacement?.release();
	},
	15000,
);

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-session-lock-'));
	process.env.SUMMON_HOME = root;
	await saveAgent('test-agent', newRecord('Test-agent', root, 'claude'));
	await writeFile(join(root, 'launches'), '');
});

afterEach(async () => {
	await writeFile(join(root, 'release-provider'), 'release');
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill();
		await child.exited;
	}
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	if (
		dirname(resolve(root)) !== resolve(tmpdir()) ||
		!basename(root).startsWith('summon-session-lock-')
	)
		throw new Error('Unsafe test cleanup');
	await rm(root, { recursive: true, force: true });
});

function launch(args: string[], delay = '0', release?: string) {
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			'--preload',
			resolve(import.meta.dir, 'fixtures/capture-launch.ts'),
			resolve(import.meta.dir, '../src/cli.ts'),
			...args,
		],
		cwd: root,
		env: {
			...process.env,
			SUMMON_HOME: root,
			CODEX_HOME: join(root, 'codex'),
			SUMMON_TEST_CAPTURE: join(root, 'launches'),
			SUMMON_TEST_DELAY: delay,
			...(release ? { SUMMON_TEST_RELEASE: release } : {}),
		},
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	});
	children.push(child);
	return child;
}

async function finish(child: ReturnType<typeof launch>) {
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, stdout, stderr };
}

test('a live session prevents every launch mode and leaves its record and notes untouched', async () => {
	const release = join(root, 'release-provider');
	const first = launch(['test-agent', '--same-window'], '0', release);
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if ((await readFile(join(root, 'launches'), 'utf8')).trim()) break;
		await Bun.sleep(20);
	}
	expect(await isAgentRunning('test-agent')).toBe(true);
	const record = await readFile(join(root, 'test-agent.json'), 'utf8');
	for (const args of [
		['test-agent'],
		['test-agent', '--new-window'],
		['test-agent', '--same-window'],
		['test-agent', '--note', 'Must not append'],
		['all'],
		['all', '--new-window'],
		['__session', 'test-agent'],
	]) {
		const result = await finish(launch(args));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('already running');
	}
	expect(await readFile(join(root, 'test-agent.json'), 'utf8')).toBe(record);
	expect(await Bun.file(join(root, 'test-agent.md')).exists()).toBe(false);
	expect((await readFile(join(root, 'launches'), 'utf8')).trim().split('\n')).toHaveLength(1);
	await writeFile(release, 'release');
	expect((await finish(first)).code).toBe(0);
	expect(await isAgentRunning('test-agent')).toBe(false);
	expect((await finish(launch(['test-agent', '--same-window']))).code).toBe(0);
	expect((await readFile(join(root, 'launches'), 'utf8')).trim().split('\n')).toHaveLength(2);
}, 25000);

test('simultaneous session processes launch only one provider', async () => {
	const results = await Promise.all([
		finish(launch(['__session', 'test-agent'], '800')),
		finish(launch(['__session', 'test-agent'], '800')),
	]);
	expect(results.every((result) => result.code === 0)).toBe(true);
	expect(results.filter((result) => result.stdout.includes('already running'))).toHaveLength(1);
	expect((await readFile(join(root, 'launches'), 'utf8')).trim().split('\n')).toHaveLength(1);
});

test('a crashed owner is recovered, including competing recovery attempts', async () => {
	const module = resolve(import.meta.dir, '../src/session-lock.ts');
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			'-e',
			`const { acquireSessionLock } = await import(${JSON.stringify(module)}); await acquireSessionLock('test-agent'); console.log('ready'); setInterval(() => {}, 1000);`,
		],
		env: { ...process.env, SUMMON_HOME: root },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	});
	children.push(child);
	const reader = child.stdout.getReader();
	await reader.read();
	reader.releaseLock();
	expect(await isAgentRunning('test-agent')).toBe(true);
	child.kill();
	await child.exited;
	expect(await isAgentRunning('test-agent')).toBe(false);
	const results = await Promise.all([
		finish(launch(['__session', 'test-agent'], '800')),
		finish(launch(['__session', 'test-agent'], '800')),
	]);
	expect(results.every((result) => result.code === 0)).toBe(true);
	expect((await readFile(join(root, 'launches'), 'utf8')).trim().split('\n')).toHaveLength(1);
});

test('spawn failure releases the session lock', async () => {
	const original = process.env.SUMMON_TEST_SPAWN_ERROR;
	process.env.SUMMON_TEST_SPAWN_ERROR = '1';
	try {
		expect((await finish(launch(['test-agent', '--same-window']))).code).toBe(1);
		expect(await isAgentRunning('test-agent')).toBe(false);
		const lock = await acquireSessionLock('test-agent');
		expect(lock).toBeDefined();
		await lock?.release();
	} finally {
		if (original === undefined) delete process.env.SUMMON_TEST_SPAWN_ERROR;
		else process.env.SUMMON_TEST_SPAWN_ERROR = original;
	}
});

test('a surviving provider keeps the lock after its runner exits', async () => {
	const module = resolve(import.meta.dir, '../src/session-lock.ts');
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			'-e',
			`const { acquireSessionLock } = await import(${JSON.stringify(module)}); const lock = await acquireSessionLock('test-agent'); await lock.setChild(${process.pid});`,
		],
		env: { ...process.env, SUMMON_HOME: root },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	});
	children.push(child);
	expect(await child.exited).toBe(0);
	expect(await isAgentRunning('test-agent')).toBe(true);
	expect(await acquireSessionLock('test-agent')).toBeUndefined();
	const other = await acquireSessionLock('other-test-agent');
	expect(other).toBeDefined();
	await other?.release();
});
