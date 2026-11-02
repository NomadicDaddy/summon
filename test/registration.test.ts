import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { newRecord } from '../src/store.ts';

interface Launch {
	cmd: string[];
	cwd?: string;
}
let root: string;
let capture: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-registration-'));
	capture = join(root, 'launches');
});

afterEach(async () => {
	const target = resolve(root);
	if (
		dirname(target) !== resolve(tmpdir()) ||
		!basename(target).startsWith('summon-registration-')
	)
		throw new Error('Refusing to remove an unexpected test directory.');
	await rm(target, { recursive: true, force: true });
});

async function invoke(args: string[], input: string) {
	await writeFile(capture, '');
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
			SUMMON_HOME: join(root, 'agents'),
			CODEX_HOME: join(root, 'codex'),
			SUMMON_TEST_CAPTURE: capture,
		},
		stdin: new Blob([input]),
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const output = (await readFile(capture, 'utf8')).trim();
	const launches = output ? output.split('\n').map((line) => JSON.parse(line) as Launch) : [];
	return { stdout, stderr, code, launches };
}

test.each(['', '\n', 'n\n', 'quit\n', 'maybe\n'])(
	'unknown names with input %j quit without any registration, notes, or launch',
	async (input) => {
		const result = await invoke(['bob', '--note', 'Do not save this'], input);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('Create a new agent?');
		expect(result.stdout).toContain('Cancelled');
		expect(result.launches).toEqual([]);
		expect(await readdir(join(root, 'agents'))).toEqual(['AGENTS.md']);
	},
);

test('explicit yes registers and launches, and later calls do not ask again', async () => {
	const created = await invoke(['bob', '--same-window'], 'Y\n');
	expect(created.code).toBe(0);
	expect(created.launches[0]?.cmd[0]).toBe('claude');
	expect(await readdir(join(root, 'agents'))).toContain('bob.json');
	const resumed = await invoke(['bob', '--same-window'], '');
	expect(resumed.code).toBe(0);
	expect(resumed.stdout).not.toContain('Create a new agent?');
	expect(resumed.launches[0]?.cmd).toContain('--resume');
});

test('list handles empty and populated stores without registering or launching', async () => {
	const empty = await invoke(['list'], 'yes\n');
	expect(empty.code).toBe(0);
	expect(empty.stdout).toContain('No registered agents');
	expect(empty.launches).toEqual([]);
	const record = newRecord('Bob', root, 'codex');
	record.domain = 'Release engineering';
	const path = join(root, 'agents', 'bob.json');
	const original = JSON.stringify(record);
	await writeFile(path, original);
	await mkdir(join(root, 'agents', 'mailboxes'));
	const listed = await invoke(['list'], '');
	expect(listed.code).toBe(0);
	expect(listed.stdout).toContain(`Bob\tcodex\t${root}`);
	expect(listed.stdout).toContain('Release engineering');
	expect(listed.launches).toEqual([]);
	expect(await readFile(path, 'utf8')).toBe(original);
	expect(await readdir(join(root, 'agents'))).not.toContain('list.json');
	const invalid = await invoke(['list', '--using', 'claude'], 'yes\n');
	expect(invalid.code).toBe(1);
	expect(invalid.stderr).toContain('Usage: summon list');
	expect(invalid.launches).toEqual([]);
});

test('all opens a terminal per registered agent in name order without rewriting records', async () => {
	const empty = await invoke(['all'], 'yes\n');
	expect(empty.code).toBe(0);
	expect(empty.stdout).toContain('No registered agents');
	expect(empty.launches).toEqual([]);

	const anna = newRecord('Anna', root, 'codex');
	const bob = newRecord('Bob', root, 'claude');
	const annaOriginal = JSON.stringify(anna);
	const bobOriginal = JSON.stringify(bob);
	await writeFile(join(root, 'agents', 'anna.json'), annaOriginal);
	await writeFile(join(root, 'agents', 'bob.json'), bobOriginal);
	await mkdir(join(root, 'agents', 'mailboxes'));

	const result = await invoke(['all'], '');
	expect(result.code).toBe(0);
	expect(result.stderr).toBe('');
	expect(result.stdout).toContain('Summoned Anna with codex');
	expect(result.stdout).toContain('Summoned Bob with claude');
	expect(result.launches).toHaveLength(2);
	for (const launch of result.launches) {
		const cmd = launch.cmd;
		expect(cmd[0]).not.toBe('codex');
		expect(cmd[0]).not.toBe('claude');
		if (platform() === 'win32') expect(cmd[0]).toBe('wt.exe');
	}
	const slugs = result.launches.map((launch) => launch.cmd.join(' '));
	expect(slugs.join('\n')).toContain('__session');
	if (platform() === 'win32') expect(slugs.join('\n')).toContain('anna');
	else expect(slugs.join('\n')).toContain("'__session' 'anna'");
	const [first, second] = slugs;
	if (!first || !second) throw new Error('Expected two terminal commands.');
	expect(first).toContain('anna');
	expect(second).toContain('bob');
	expect(await readFile(join(root, 'agents', 'anna.json'), 'utf8')).toBe(annaOriginal);
	expect(await readFile(join(root, 'agents', 'bob.json'), 'utf8')).toBe(bobOriginal);
	expect(await readdir(join(root, 'agents'))).not.toContain('all.json');
	const invalid = await invoke(['all', '--using', 'claude'], 'yes\n');
	expect(invalid.code).toBe(1);
	expect(invalid.stderr).toContain('Usage: summon all');
	expect(invalid.launches).toEqual([]);
});

test.skipIf(platform() !== 'win32')(
	'team tabs share a window and separate windows remain optional',
	async () => {
		const first = await invoke(['test-one'], 'yes\n');
		const second = await invoke(['test-two'], 'yes\n');
		const window = first.launches[0]?.cmd[2];
		expect(window).toStartWith('summon-');
		expect(second.launches[0]?.cmd[2]).toBe(window);
		expect(first.launches[0]?.cmd).toContain('--suppressApplicationTitle');
		const all = await invoke(['all'], '');
		expect(all.launches).toHaveLength(2);
		for (const launch of all.launches) expect(launch.cmd[2]).toBe(window);
		const separate = await invoke(['test-one', '--new-window'], '');
		expect(separate.launches[0]?.cmd[2]).toBe('new');
		const separateAll = await invoke(['all', '--new-window'], '');
		for (const launch of separateAll.launches) expect(launch.cmd[2]).toBe('new');
		const conflict = await invoke(['test-one', '--same-window', '--new-window'], '');
		expect(conflict.code).toBe(1);
		expect(conflict.launches).toEqual([]);
	},
);

test('all skips agents whose working directory is gone and still summons the rest', async () => {
	await mkdir(join(root, 'agents'), { recursive: true });
	const anna = newRecord('Anna', join(root, 'vanished'), 'codex');
	const bob = newRecord('Bob', root, 'claude');
	await writeFile(join(root, 'agents', 'anna.json'), JSON.stringify(anna));
	await writeFile(join(root, 'agents', 'bob.json'), JSON.stringify(bob));

	const result = await invoke(['all'], '');
	expect(result.code).toBe(1);
	expect(result.stderr).toContain('Cannot summon Anna');
	expect(result.stderr).toContain('Working directory does not exist');
	expect(result.stdout).toContain('Summoned Bob with claude');
	expect(result.stdout).not.toContain('No registered agents');
	expect(result.launches).toHaveLength(1);
	expect(JSON.stringify(result.launches[0]?.cmd)).toContain('bob');
	expect(await readFile(join(root, 'agents', 'anna.json'), 'utf8')).toBe(JSON.stringify(anna));
});
