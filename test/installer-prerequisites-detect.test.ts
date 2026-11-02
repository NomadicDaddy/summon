import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createHarness, helperRun } from './fixtures/prerequisite-helper.ts';

const windows = process.platform === 'win32' ? test : test.skip;
let harness: Awaited<ReturnType<typeof createHarness>> | undefined;

beforeAll(async () => {
	if (process.platform === 'win32') harness = await createHarness();
}, 60_000);
// stop() waits for every fixture child the cases started, up to 30 s.
afterAll(async () => {
	await harness?.stop();
}, 40_000);

function use() {
	if (!harness) throw new Error('The prerequisite helper harness is Windows-only.');
	return harness;
}

windows('detection reports missing when neither runtime exists anywhere', async () => {
	const where = await use().fixture();
	expect(await helperRun(where, 'detect')).toMatchObject({
		'bun.status': 'missing',
		'pwsh.status': 'missing',
		winget: '0',
	});
});

windows('detection finds current runtimes on the machine and the user PATH', async () => {
	const where = await use().fixture();
	await use().runtime(where.search, 'bun.exe', { output: '1.4.3' });
	const userFolder = join(where.base, 'user PATH folder');
	await use().runtime(userFolder, 'pwsh.exe', { output: 'PowerShell 7.6.9' });
	await writeFile(where.pathStore, `${userFolder}\r\n`);
	expect(await helperRun(where, 'detect')).toMatchObject({
		'bun.status': 'found',
		'bun.version': '1.4.3',
		'bun.onpath': '1',
		'pwsh.status': 'found',
		'pwsh.version': '7.6.9',
		'pwsh.onpath': '1',
	});
});

// Summon resolves pwsh.exe through PATH alone, so a copy elsewhere is one it cannot start with
// (Roger r3 #1): setup must offer to install, never call it found.
windows('a PowerShell outside PATH is missing, wherever it is installed', async () => {
	const where = await use().fixture();
	await use().runtime(join(where.base, 'Program Files', 'PowerShell', '7'), 'pwsh.exe', {
		output: 'PowerShell 7.6.9',
	});
	await use().runtime(join(where.local, 'Microsoft', 'WinGet', 'Links'), 'pwsh.exe', {
		output: 'PowerShell 7.6.9',
	});
	expect((await helperRun(where, 'detect'))['pwsh.status']).toBe('missing');
});

windows('detection reports too-old and unreadable versions, never current', async () => {
	const where = await use().fixture();
	await use().runtime(where.search, 'bun.exe', { output: '1.4.2' });
	await use().runtime(where.search, 'pwsh.exe', { output: 'PowerShell 7.6.0-preview.4' });
	expect(await helperRun(where, 'detect')).toMatchObject({
		'bun.status': 'outdated',
		'bun.version': '1.4.2',
		'pwsh.status': 'unreadable',
	});
});

windows('a copy that exits non-zero is unreadable', async () => {
	const where = await use().fixture();
	await use().runtime(where.search, 'bun.exe', { output: '1.4.3', exit: 3 });
	expect((await helperRun(where, 'detect'))['bun.status']).toBe('unreadable');
});

windows('Windows PowerShell 5.1 alone never satisfies PowerShell 7', async () => {
	const where = await use().fixture();
	await use().runtime(where.search, 'powershell.exe', { output: '5.1.26100' });
	expect((await helperRun(where, 'detect'))['pwsh.status']).toBe('missing');
});

// The setup half of one rule; installer-launcher.test.ts holds the launch half.
windows('the first copy that exists decides, as the launcher runs it', async () => {
	const where = await use().fixture();
	await writeFile(join(where.search, 'bun.exe'), 'not an executable');
	await use().runtime(join(where.profile, '.bun', 'bin'), 'bun.exe', { output: '1.4.3' });
	expect(await helperRun(where, 'detect')).toMatchObject({
		'bun.status': 'unreadable',
		'bun.onpath': '1',
	});
	await use().runtime(where.search, 'pwsh.exe', { output: 'PowerShell 7.4.22' });
	const later = join(where.base, 'later PATH folder');
	await use().runtime(later, 'pwsh.exe', { output: 'PowerShell 7.6.9' });
	expect(
		await helperRun(where, 'detect', { machinePath: `${where.search};${later}` }),
	).toMatchObject({
		'pwsh.status': 'outdated',
		'pwsh.version': '7.4.22',
	});
});

windows('the standard folders count only when PATH has no copy', async () => {
	const where = await use().fixture();
	await use().runtime(join(where.local, 'Microsoft', 'WinGet', 'Links'), 'bun.exe');
	expect(await helperRun(where, 'detect')).toMatchObject({
		'bun.status': 'found',
		'bun.onpath': '0',
	});
});

windows(
	'a hung probe really ran, is cut off and leaves no process behind',
	async () => {
		const where = await use().fixture();
		const pidfile = join(where.base, 'probe.pid');
		await use().runtime(where.search, 'bun.exe', { sleep: 20_000, pidfile });
		const started = Date.now();
		expect(
			await helperRun(where, 'detect', { extra: ['-ProbeTimeoutMs', '1500'] }),
		).toMatchObject({
			'bun.status': 'unreadable',
		});
		expect(Date.now() - started).toBeLessThan(8000);
		const pid = Number(await readFile(pidfile, 'utf8'));
		expect(pid).toBeGreaterThan(0);
		expect(() => process.kill(pid, 0)).toThrow();
		// Room for a mutant that waits out the probe: helperRun kills it at 12 s and fails the case.
	},
	45_000,
);

windows('a probe that floods stderr is drained and still read', async () => {
	const where = await use().fixture();
	await use().runtime(where.search, 'bun.exe', { output: '1.4.3', stderr: 200_000 });
	expect(await helperRun(where, 'detect')).toMatchObject({
		'bun.status': 'found',
		'bun.version': '1.4.3',
	});
});

windows(
	'the whole run is bounded even when every probe stays under its own timeout',
	async () => {
		const where = await use().fixture();
		await use().runtime(where.search, 'bun.exe', { sleep: 1200 });
		await use().runtime(where.search, 'pwsh.exe', { output: 'PowerShell 7.6.9', sleep: 1200 });
		const result = await helperRun(where, 'detect', { extra: ['-TotalTimeoutMs', '1500'] });
		// The deadline runs out during the second probe, which is then reported unreadable.
		expect(result['pwsh.status']).toBe('unreadable');
	},
	30_000,
);

windows('relative PATH entries are never searched or run (Morgan r1 High 3)', async () => {
	const where = await use().fixture();
	const marker = join(where.base, 'planted.pid');
	await use().runtime(join(where.base, 'tools'), 'bun.exe', { pidfile: marker });
	await use().runtime(where.base, 'bun.exe', { pidfile: marker });
	await use().runtime(where.search, 'bun.exe', { output: '1.4.3' });
	expect(
		await helperRun(where, 'detect', {
			machinePath: `tools;.;${where.search}`,
			cwd: where.base,
		}),
	).toMatchObject({ 'bun.status': 'found', 'bun.version': '1.4.3' });
	expect(await Bun.file(marker).exists()).toBe(false);
});

windows('a real Bun is probed natively, found, and outdated against a higher minimum', async () => {
	const where = await use().fixture();
	// This local fixture copy is never packaged or distributed.
	await copyFile(process.execPath, join(where.search, 'bun.exe'));
	expect(await helperRun(where, 'detect')).toMatchObject({
		'bun.status': 'found',
		'bun.version': Bun.version,
	});
	expect(await helperRun(where, 'detect', { bunMinimum: '99.0.0' })).toMatchObject({
		'bun.status': 'outdated',
		'bun.version': Bun.version,
	});
});
