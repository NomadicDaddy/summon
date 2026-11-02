import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		const target = resolve(root);
		if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('summon-init-'))
			throw new Error('Refusing to remove an unexpected test directory.');
		await rm(target, { recursive: true, force: true });
	}
});

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'summon-init-'));
	roots.push(root);
	return join(root, 'agent home');
}

async function initialize(root: string, args = ['--help']): Promise<number> {
	const child = Bun.spawn({
		cmd: [process.execPath, resolve(import.meta.dir, '../src/cli.ts'), ...args],
		env: { ...process.env, SUMMON_HOME: root },
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'ignore',
		windowsHide: true,
	});
	return child.exited;
}

test('help installs missing instructions, replaces drift, and leaves matching copies untouched', async () => {
	const root = await fixture();
	expect(await initialize(root)).toBe(0);
	const destination = join(root, 'AGENTS.md');
	expect(await readFile(destination, 'utf8')).toBe(
		await readFile(resolve(import.meta.dir, '../templates/AGENTS.md.template'), 'utf8'),
	);
	await writeFile(destination, 'My local teammate instructions.\n');
	expect(await initialize(root)).toBe(0);
	expect(await readFile(destination, 'utf8')).toBe(
		await readFile(resolve(import.meta.dir, '../templates/AGENTS.md.template'), 'utf8'),
	);
	const oldTime = new Date('2000-01-01T00:00:00Z');
	await utimes(destination, oldTime, oldTime);
	const before = (await stat(destination)).mtimeMs;
	expect(await initialize(root, ['--skills', 'status'])).toBe(0);
	expect((await stat(destination)).mtimeMs).toBe(before);
});

test('simultaneous initialization succeeds without replacing instructions', async () => {
	const root = await fixture();
	expect(await Promise.all([initialize(root), initialize(root)])).toEqual([0, 0]);
	expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(
		await readFile(resolve(import.meta.dir, '../templates/AGENTS.md.template'), 'utf8'),
	);
});

test('even an invalid invocation installs instructions and storage errors are reported', async () => {
	const root = await fixture();
	expect(await initialize(root, ['--unknown'])).toBe(1);
	expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toContain('Join the summon team');
	const blocked = await fixture();
	await mkdir(dirname(blocked), { recursive: true });
	await writeFile(blocked, 'A file cannot be a storage directory.');
	expect(await initialize(blocked)).toBe(1);
});
