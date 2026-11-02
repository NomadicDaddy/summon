import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { mkdir, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { prepareStorageLayout, requireCompatibleTeamLayout } from '../src/storage-layout.ts';
import { storageRoot, teamLabel } from '../src/storage-root.ts';
import { assertTeamBuildLayout } from '../src/team-build-layout.ts';
import { storageLayoutHarness } from './fixtures/storage-layout.ts';

let fixture: Awaited<ReturnType<typeof storageLayoutHarness>>;
beforeEach(async () => {
	fixture = await storageLayoutHarness();
});
afterEach(async () => fixture.dispose());

test('forward layout selection refuses legacy data before it can be adopted; old rollback remains possible', async () => {
	const mailbox = join(fixture.base, 'mailboxes');
	await mkdir(mailbox, { recursive: true });
	await writeFile(join(mailbox, 'retained.txt'), 'unchanged legacy bytes');
	await rejects(requireCompatibleTeamLayout(fixture.base, 1), /legacy default-team data/);
	expect(await readFile(join(mailbox, 'retained.txt'), 'utf8')).toBe('unchanged legacy bytes');
	expect(await readdir(fixture.base)).toEqual(['mailboxes']);
	await requireCompatibleTeamLayout(fixture.base, undefined);
});

test('new layout can select an empty default-free base but cannot take over an unmarked destination', async () => {
	await requireCompatibleTeamLayout(fixture.base, 1);
	await mkdir(join(fixture.base, 'maintenance'), { recursive: true });
	await mkdir(join(fixture.base, 'team-named'));
	await requireCompatibleTeamLayout(fixture.base, 1);
	await mkdir(fixture.selected);
	await rejects(requireCompatibleTeamLayout(fixture.base, 1), /unmarked teams base/);
	expect(await readdir(fixture.selected)).toEqual([]);
});

test('interrupted fresh initialization stays byte-identical until an explicit empty-fixture reset', async () => {
	await mkdir(fixture.selected, { recursive: true });
	const marker = join(fixture.base, '.team-layout.json');
	const pending = JSON.stringify({ version: 1, defaultTeam: 'team-default', state: 'pending' });
	await writeFile(marker, pending);
	await rejects(prepareStorageLayout(), /incomplete/);
	await rejects(prepareStorageLayout(), /incomplete/);
	expect(await readFile(marker, 'utf8')).toBe(pending);
	expect(await readdir(fixture.selected)).toEqual([]);
	// This is the fixture's explicit offline reset, never startup recovery or a live-store command.
	await rmdir(fixture.selected);
	await unlink(marker);
	await prepareStorageLayout();
	expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({
		version: 1,
		defaultTeam: 'team-default',
		state: 'ready',
	});
});

test('forward selection also refuses mixed or missing marked destinations', async () => {
	await mkdir(fixture.base, { recursive: true });
	await writeFile(
		join(fixture.base, '.team-layout.json'),
		JSON.stringify({
			version: 1,
			defaultTeam: 'team-default',
			state: 'ready',
		}),
	);
	await rejects(requireCompatibleTeamLayout(fixture.base, 1), /directory is missing/);
	await mkdir(fixture.selected);
	await mkdir(join(fixture.base, 'runtime'));
	await rejects(requireCompatibleTeamLayout(fixture.base, 1), /legacy default-team data/);
	expect(await readdir(fixture.selected)).toEqual([]);
});

test('window ABI refuses old, missing or malformed build metadata without touching the bundle', async () => {
	const directory = join(fixture.root, 'bundle');
	await mkdir(directory);
	const script = join(directory, 'main.mjs');
	await writeFile(script, 'old bundle bytes');
	await rejects(assertTeamBuildLayout(directory), /incompatible storage launch layout/);
	const metadata = join(directory, 'build.json');
	await writeFile(metadata, JSON.stringify({ version: '0.28.3' }));
	await rejects(assertTeamBuildLayout(directory), /incompatible storage launch layout/);
	await writeFile(metadata, '{broken');
	await rejects(assertTeamBuildLayout(directory), /incompatible storage launch layout/);
	await writeFile(metadata, JSON.stringify({ storageLayout: 2 }));
	await rejects(assertTeamBuildLayout(directory), /incompatible storage launch layout/);
	await writeFile(metadata, JSON.stringify({ storageLayout: 1 }));
	await assertTeamBuildLayout(directory);
	expect(await readFile(script, 'utf8')).toBe('old bundle bytes');
	expect((await readdir(directory)).sort()).toEqual(['build.json', 'main.mjs']);
});

test('the team-prefix label uses the same casing predicate as managed selection', () => {
	process.env.SUMMON_HOME = join(fixture.base, 'Team-Mixed');
	expect(storageRoot()).toBe(join(fixture.base, 'Team-Mixed'));
	expect(teamLabel()).toBe('Mixed');
});
