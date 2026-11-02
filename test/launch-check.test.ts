import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { checkLaunch, executableOnPath, installedProviders } from '../src/desktop/launch-check.ts';
import { saveProfile } from '../src/team-maintenance.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

test('CLI lookup accepts executable files, rejects directories and missing commands', async () => {
	const bin = join(fixture.root, 'bin');
	await mkdir(bin);
	const command = join(bin, process.platform === 'win32' ? 'probe.EXE' : 'probe');
	await writeFile(command, 'fixture');
	await chmod(command, 0o700);
	expect(await executableOnPath('probe', bin)).toBe(true);
	expect(await executableOnPath('absent', bin)).toBe(false);
	await mkdir(join(bin, 'directory'));
	expect(await executableOnPath('directory', bin)).toBe(false);
});

test('installed choices include only supported executables, not model servers', async () => {
	const bin = join(fixture.root, 'choices');
	await mkdir(bin);
	expect(await installedProviders(bin)).toEqual([]);
	for (const command of ['codex', 'kilo', 'lms']) {
		const file = join(bin, process.platform === 'win32' ? `${command}.cmd` : command);
		await writeFile(file, 'fixture');
		await chmod(file, 0o700);
	}
	expect(await installedProviders(bin)).toEqual(['codex', 'kilo']);
});

test('a missing CLI points to setup guidance without launching a provider', async () => {
	await saveProfile(
		{
			name: 'New',
			provider: 'codex',
			cwd: fixture.root,
			expertise: '',
			domain: '',
			backup: '',
			notes: '',
			notesRevision: null,
			profileRevision: null,
			sessionId: '',
		},
		null,
	);
	const previousPath = process.env.PATH;
	process.env.PATH = fixture.root;
	try {
		const message = await checkLaunch('new').catch((error: unknown) => String(error));
		expect(message).toContain('codex was not found');
		expect(message).toContain('CLI setup in Maintenance');
		expect(message).toContain('reopen Summon to refresh PATH');
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
	}
});

test('missing folder gives actionable feedback before any launch', async () => {
	await saveProfile(
		{
			name: 'New',
			provider: 'codex',
			cwd: fixture.root,
			expertise: '',
			domain: '',
			backup: '',
			notes: '',
			notesRevision: null,
			profileRevision: null,
			sessionId: '',
		},
		null,
	);
	const path = join(fixture.records, 'new.json');
	const record = (await Bun.file(path).json()) as Record<string, unknown>;
	record.cwd = join(fixture.root, 'missing');
	await writeFile(path, JSON.stringify(record));
	expect(await checkLaunch('new').catch((error: unknown) => String(error))).toContain(
		'Choose an existing folder',
	);
	expect(
		await saveProfile(
			{
				name: 'Other',
				provider: 'codex',
				cwd: record.cwd,
				expertise: '',
				domain: '',
				backup: '',
				notes: '',
				notesRevision: null,
				profileRevision: null,
				sessionId: '',
			},
			null,
		).catch((error: unknown) => String(error)),
	).toContain('existing absolute directory');
});
