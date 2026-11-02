import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import {
	link,
	mkdir,
	readdir,
	readFile,
	rm,
	rmdir,
	symlink,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { prepareTeamWindowStorage } from '../src/desktop/startup-root.ts';
import { initializeStore } from '../src/init.ts';
import { assertStorageLayout, requireCompatibleTeamLayout } from '../src/storage-layout.ts';
import {
	selectedTeamsBase,
	standaloneBaseArgument,
	storageRoot,
	teamLabel,
} from '../src/storage-root.ts';
import { configureStorage } from '../src/storage-startup.ts';
import { storageLayoutHarness } from './fixtures/storage-layout.ts';

let fixture: Awaited<ReturnType<typeof storageLayoutHarness>>;
let root: string;
let base: string;
let selected: string;
const ready = { version: 1, defaultTeam: 'team-default', state: 'ready' };

beforeEach(async () => {
	fixture = await storageLayoutHarness();
	({ root, base, selected } = fixture);
});
afterEach(async () => fixture.dispose());

async function marked(state: unknown = ready): Promise<void> {
	await mkdir(selected, { recursive: true });
	await writeFile(join(base, '.team-layout.json'), JSON.stringify(state));
}

test('default selection is read-only until an empty installation initializes under team-default', async () => {
	expect(storageRoot()).toBe(selected);
	expect(teamLabel()).toBeUndefined();
	await assertStorageLayout();
	expect(await Bun.file(join(base, '.team-layout.json')).exists()).toBe(false);
	await initializeStore();
	expect(JSON.parse(await readFile(join(base, '.team-layout.json'), 'utf8'))).toEqual(ready);
	expect(await readFile(join(selected, 'AGENTS.md'), 'utf8')).toContain('Join the summon team');
	expect((await readdir(base)).sort()).toEqual(['.team-layout.json', 'team-default']);
	await initializeStore();
	expect((await readdir(base)).sort()).toEqual(['.team-layout.json', 'team-default']);
});

test('legacy default state refuses before initialization and is never copied or rewritten', async () => {
	await mkdir(join(base, 'runtime'), { recursive: true });
	await writeFile(join(base, 'AGENTS.md'), 'old instructions');
	await writeFile(join(base, 'alpha.json'), 'old registration bytes');
	await rejects(initializeStore(), /legacy default-team data/);
	expect(await readFile(join(base, 'AGENTS.md'), 'utf8')).toBe('old instructions');
	expect(await readFile(join(base, 'alpha.json'), 'utf8')).toBe('old registration bytes');
	expect((await readdir(base)).sort()).toEqual(['AGENTS.md', 'alpha.json', 'runtime']);
	process.env.SUMMON_HOME = base;
	await rejects(assertStorageLayout(), /teams base, not a team/);
});

test('simultaneous cold starts leave one complete layout or an explicit safe refusal', async () => {
	const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => initializeStore()));
	expect(attempts.some((attempt) => attempt.status === 'fulfilled')).toBe(true);
	for (const attempt of attempts) {
		if (attempt.status === 'rejected')
			expect(String(attempt.reason)).toContain('Team storage is not ready');
	}
	await assertStorageLayout();
	expect(JSON.parse(await readFile(join(base, '.team-layout.json'), 'utf8'))).toEqual(ready);
	expect((await readdir(base)).sort()).toEqual(['.team-layout.json', 'team-default']);
	expect(await readFile(join(selected, 'AGENTS.md'), 'utf8')).toContain('Join the summon team');
});

test('a cold CLI initializes the new default path without requiring an explicit SUMMON_HOME', async () => {
	const child = Bun.spawn(
		[process.execPath, resolve(import.meta.dir, '../src/cli.ts'), '--help'],
		{
			env: { ...process.env, SUMMON_HOME: '', SUMMON_AGENT: '', SUMMON_NONCE: '' },
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
		},
	);
	const [code, output, error] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(error).toBe('');
	expect(code).toBe(0);
	expect(output).toContain('summon <name>');
	expect(await Bun.file(join(selected, 'AGENTS.md')).exists()).toBe(true);
	expect(await Bun.file(join(base, 'AGENTS.md')).exists()).toBe(false);
});

test('read-only CLI routing refuses legacy storage without initializing a second team', async () => {
	await mkdir(base);
	await writeFile(join(base, 'AGENTS.md'), 'preserve me');
	const child = Bun.spawn(
		[process.execPath, resolve(import.meta.dir, '../src/cli.ts'), '--work'],
		{
			env: {
				...process.env,
				SUMMON_HOME: '',
				SUMMON_AGENT: 'alpha',
				SUMMON_NONCE: 'fixture',
			},
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
		},
	);
	const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	expect(code).toBe(1);
	expect(error).toContain('legacy default-team data');
	expect(await readdir(base)).toEqual(['AGENTS.md']);
});

test('unmarked destinations and unknown base entries require an operator plan', async () => {
	await mkdir(selected, { recursive: true });
	await rejects(assertStorageLayout(), /unmarked teams base/);
	await rmdir(selected);
	await writeFile(join(base, 'unclassified.txt'), 'preserve');
	await rejects(initializeStore(), /unclassified\.txt/);
	expect(await readFile(join(base, 'unclassified.txt'), 'utf8')).toBe('preserve');
	expect(await Bun.file(join(base, '.team-layout.json')).exists()).toBe(false);
});

test('pending, unsupported, malformed and oversized markers refuse without touching data', async () => {
	await marked();
	await writeFile(join(selected, 'alpha.md'), 'unchanged notes');
	for (const marker of [
		JSON.stringify({ ...ready, state: 'pending' }),
		JSON.stringify({ ...ready, version: 2 }),
		JSON.stringify({ ...ready, unexpected: true }),
		'{broken',
		' '.repeat(1025),
	]) {
		await writeFile(join(base, '.team-layout.json'), marker);
		await rejects(initializeStore(), /Team storage is not ready/);
		expect(await readFile(join(selected, 'alpha.md'), 'utf8')).toBe('unchanged notes');
		expect(await Bun.file(join(selected, 'AGENTS.md')).exists()).toBe(false);
	}
});

test('ready layout preserves saved bytes; mixed or lost roots refuse', async () => {
	await marked();
	const files = [
		'alpha.md',
		'notepad/note.md',
		'runtime/team-window/Local Storage/draft',
		'runtime/alpha/checkpoint/package.json',
		'mailboxes/alpha/read/receipt',
		'schedules/state.json',
	];
	for (const file of files) {
		await mkdir(dirname(join(selected, file)), { recursive: true });
		await writeFile(join(selected, file), `original ${file} Ω\r\n`);
	}
	await writeFile(join(base, 'unregistered-remnant.md'), 'preserved outside selected team');
	await initializeStore();
	for (const file of files)
		expect(await readFile(join(selected, file), 'utf8')).toBe(`original ${file} Ω\r\n`);
	await mkdir(join(base, 'runtime'));
	await rejects(assertStorageLayout(), /legacy default-team data/);
	await rmdir(join(base, 'runtime'));
	await rm(selected, { recursive: true });
	await rejects(initializeStore(), /directory is missing/);
	expect(await readdir(base)).not.toContain('team-default');
});

test('directory redirects and hardlinked layout markers are refused', async () => {
	await mkdir(base);
	const elsewhere = join(root, 'other data');
	await mkdir(elsewhere);
	await symlink(elsewhere, selected, process.platform === 'win32' ? 'junction' : 'dir');
	await rejects(initializeStore(), /real directories/);
	expect(await readdir(elsewhere)).toEqual([]);
	await unlink(selected);
	await marked();
	await link(join(base, '.team-layout.json'), join(root, 'marker-copy'));
	await rejects(assertStorageLayout(), /single-link file/);
});

test('named stores remain siblings and pending base operations fence their startup', async () => {
	await configureStorage(['--team', 'one']);
	await initializeStore();
	expect(storageRoot()).toBe(join(base, 'team-one'));
	expect(teamLabel()).toBe('one');
	await configureStorage(['--team', 'two']);
	await initializeStore();
	expect(storageRoot()).toBe(join(base, 'team-two'));
	expect(await readdir(join(base, 'team-one'))).toEqual(['AGENTS.md']);
	await marked({ ...ready, state: 'pending' });
	await rejects(configureStorage(['--team', 'one']), /incomplete/);
});

test('custom selected stores are exact and named selection requires an explicit base', async () => {
	const custom = join(root, 'standalone');
	process.env.SUMMON_HOME = custom;
	delete process.env.SUMMON_TEAMS_HOME;
	await initializeStore();
	expect(storageRoot()).toBe(custom);
	expect(await readdir(custom)).toEqual(['AGENTS.md']);
	await configureStorage(['--team']);
	expect(selectedTeamsBase()).toBeUndefined();
	expect(process.env.SUMMON_TEAMS_HOME).toBeUndefined();
	await rejects(configureStorage(['--team', 'other']), /SUMMON_TEAMS_HOME explicitly/);
});

test('window startup rejects old arguments and retains a standalone custom store', async () => {
	const custom = join(root, 'custom window');
	await rejects(
		prepareTeamWindowStorage([custom, 'bun', 'cli', 'receipt']),
		/Open the team window/,
	);
	expect(await Bun.file(join(custom, 'AGENTS.md')).exists()).toBe(false);
	expect(
		await prepareTeamWindowStorage([custom, 'bun', 'cli', standaloneBaseArgument, 'receipt']),
	).toEqual(['bun', 'cli', 'receipt']);
	expect(storageRoot()).toBe(custom);
	expect(selectedTeamsBase()).toBeUndefined();
	await rejects(configureStorage(['--team', 'other']), /SUMMON_TEAMS_HOME explicitly/);
});

test('internal runners carry root and base; members cannot select another store', async () => {
	await marked();
	process.env.SUMMON_HOME = join(root, 'stale window root');
	process.env.SUMMON_TEAMS_HOME = join(root, 'stale base');
	const args = [
		'__session',
		'alpha',
		'--storage-root',
		selected,
		'--teams-base',
		base,
		'--launch-nonce',
		'nonce',
	];
	expect(await configureStorage(args)).toEqual(['__session', 'alpha', '--launch-nonce', 'nonce']);
	expect(storageRoot()).toBe(selected);
	expect(process.env.SUMMON_TEAMS_HOME).toBe(base);
	process.env.SUMMON_AGENT = 'alpha';
	await rejects(
		configureStorage(['__session', 'alpha', '--storage-root', join(base, 'team-peer')]),
		/cannot select another/,
	);
	expect(storageRoot()).toBe(selected);
});

test('maintenance rejects a build that cannot read the moved layout', async () => {
	await requireCompatibleTeamLayout(base, undefined);
	await marked();
	await requireCompatibleTeamLayout(base, 1);
	await rejects(requireCompatibleTeamLayout(base, undefined), /matching data and build/);
	await rejects(requireCompatibleTeamLayout(base, 2), /matching data and build/);
	await marked({ ...ready, state: 'pending' });
	await rejects(requireCompatibleTeamLayout(base, 1), /incomplete/);
});
