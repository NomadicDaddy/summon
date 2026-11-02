import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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
const requests = (): number => harness?.requests() ?? 0;

windows(
	'Bun installs through winget per-user with the agreements accepted on the page',
	async () => {
		const where = await use().fixture();
		const path = await use().winget(where, 0, {
			installs: {
				folder: join(where.local, 'Microsoft', 'WinGet', 'Links'),
				name: 'bun.exe',
			},
		});
		const before = requests();
		expect(await helperRun(where, 'install', { id: 'bun', winget: path })).toMatchObject({
			outcome: 'installed',
			route: 'winget',
			version: '1.4.3',
		});
		const args = await readFile(join(where.base, 'winget-args.txt'), 'utf8');
		for (const expected of [
			'install --id Oven-sh.Bun --exact --source winget --scope user',
			'--accept-package-agreements',
			'--accept-source-agreements',
		])
			expect(args).toContain(expected);
		expect(requests()).toBe(before);
	},
);

windows('a no-package winget result lets Bun use the pinned official download', async () => {
	const where = await use().fixture();
	const path = await use().winget(where, -1978335212); // 0x8A150014 NO_APPLICATIONS_FOUND
	expect(await helperRun(where, 'install', { id: 'bun', winget: path })).toMatchObject({
		outcome: 'installed',
		route: 'fallback',
		code: '0x8A150014',
		version: '1.4.3',
	});
	expect((await readFile(where.pathStore, 'utf8')).trim()).toBe(
		join(where.profile, '.bun', 'bin'),
	);
});

for (const [label, code, outcome, hex] of [
	['user cancellation', -1978334964, 'cancelled', '0x8A15010C'],
	['a policy block', -1978335174, 'failed', '0x8A15003A'],
	['a missing network', -1978334969, 'failed', '0x8A150107'],
] as const)
	windows(`${label} from winget ends the Bun attempt with no fallback download`, async () => {
		const where = await use().fixture();
		const path = await use().winget(where, code);
		const before = requests();
		expect(await helperRun(where, 'install', { id: 'bun', winget: path })).toMatchObject({
			outcome,
			route: 'winget',
			code: hex,
		});
		expect(requests()).toBe(before);
		expect(await Bun.file(where.pathStore).exists()).toBe(false);
	});

windows('PowerShell never falls back to the ZIP while winget is present (D1)', async () => {
	const where = await use().fixture();
	const path = await use().winget(where, -1978335212); // a code Bun would fall back on
	const before = requests();
	expect(await helperRun(where, 'install', { id: 'pwsh', winget: path })).toMatchObject({
		outcome: 'failed',
		route: 'winget',
	});
	expect(await readFile(join(where.base, 'winget-args.txt'), 'utf8')).toContain(
		'install --id Microsoft.PowerShell --exact --source winget --scope machine',
	);
	expect(await readFile(join(where.base, 'winget-args.txt'), 'utf8')).toContain(
		'--installer-type wix',
	);
	expect(requests()).toBe(before);
});

windows(
	'without winget, PowerShell installs the pinned ZIP per-user into a versioned folder',
	async () => {
		const where = await use().fixture();
		expect(await helperRun(where, 'install', { id: 'pwsh' })).toMatchObject({
			outcome: 'installed',
			route: 'fallback',
			version: '7.6.9',
		});
		const folder = join(where.local, 'Programs', 'PowerShell', '7.6.9');
		expect(await Bun.file(join(folder, 'pwsh.dll')).exists()).toBe(true);
		expect((await readFile(where.pathStore, 'utf8')).trim()).toBe(folder);
	},
);

windows('a hash mismatch refuses the download before anything is extracted', async () => {
	const where = await use().fixture({ bunHash: '0'.repeat(64) });
	expect(await helperRun(where, 'install', { id: 'bun' })).toMatchObject({
		outcome: 'failed',
		route: 'fallback',
	});
	expect(await Bun.file(join(where.profile, '.bun', 'bin', 'bun.exe')).exists()).toBe(false);
	expect(await Bun.file(where.pathStore).exists()).toBe(false);
});

for (const [transfer, extra] of [
	['offline', []],
	['stall', ['-DownloadStallTimeoutMs', '1500']],
	['trickle', ['-DownloadStallTimeoutMs', '1500', '-TotalTimeoutMs', '2500']],
] as const)
	windows(
		`a ${transfer} download is reported as a failure, never held open`,
		async () => {
			const where = await use().fixture({ transfer });
			const started = Date.now();
			const result = await helperRun(where, 'install', { id: 'bun', extra: [...extra] });
			expect(result).toMatchObject({ outcome: 'failed', route: 'fallback' });
			expect(result.detail).toContain(
				'could not be fetched, stalled or did not finish in time',
			);
			expect(Date.now() - started).toBeLessThan(10_000);
			expect(await Bun.file(where.pathStore).exists()).toBe(false);
		},
		30_000,
	);

// Headers arrive 4 s into a 6 s run and the body then stalls. Each read may wait only for the
// time left, so the run ends near its deadline, not a full stall limit after it (Roger r3 #5).
windows(
	'a late answer that then stalls still ends at the run deadline',
	async () => {
		const where = await use().fixture({ transfer: 'late' });
		const started = Date.now();
		const result = await helperRun(where, 'install', {
			id: 'bun',
			extra: ['-DownloadStallTimeoutMs', '60000', '-TotalTimeoutMs', '6000'],
		});
		expect(result).toMatchObject({ outcome: 'failed', route: 'fallback' });
		expect(Date.now() - started).toBeLessThan(8500);
	},
	30_000,
);

windows(
	'winget that has not finished in time is reported unfinished and left running',
	async () => {
		const where = await use().fixture();
		const path = await use().winget(where, 0, { waitSeconds: 8 });
		const before = requests();
		const started = Date.now();
		const result = await helperRun(where, 'install', {
			id: 'bun',
			winget: path,
			extra: ['-WingetTimeoutMs', '1500'],
		});
		expect(result).toMatchObject({ outcome: 'unfinished', route: 'winget' });
		expect(Date.now() - started).toBeLessThan(6000);
		expect(requests()).toBe(before);
		// The helper leaves winget running; the test still waits for its stand-in to end.
		await use().settled();
		expect(await Bun.file(join(where.base, 'winget-done.txt')).exists()).toBe(true);
	},
	30_000,
);

windows('the Bun fallback keeps an existing bun.exe beside the new one', async () => {
	const where = await use().fixture();
	const folder = join(where.profile, '.bun', 'bin');
	await mkdir(folder, { recursive: true });
	await writeFile(join(folder, 'bun.exe'), 'previous copy');
	const result = await helperRun(where, 'install', { id: 'bun' });
	expect(result).toMatchObject({ outcome: 'installed', route: 'fallback', version: '1.4.3' });
	expect(result.detail).toContain('kept beside it');
	const kept = (await readdir(folder)).filter((name) =>
		name.startsWith('bun.exe.before-summon-'),
	);
	expect(kept).toHaveLength(1);
	expect(await readFile(join(folder, kept[0] ?? ''), 'utf8')).toBe('previous copy');
	expect(await Bun.file(join(folder, 'bun.exe.summon-new')).exists()).toBe(false);
});

// The replacement is staged complete before the active name changes (Roger r3 #2).
windows('a Bun that cannot be staged leaves the current bun.exe untouched', async () => {
	const where = await use().fixture();
	const folder = join(where.profile, '.bun', 'bin');
	await mkdir(folder, { recursive: true });
	await writeFile(join(folder, 'bun.exe'), 'previous copy');
	await writeFile(join(folder, 'bun.exe.summon-new'), 'left by an earlier attempt');
	const result = await helperRun(where, 'install', { id: 'bun' });
	expect(result).toMatchObject({ outcome: 'failed', route: 'fallback' });
	expect(result.detail).toContain('bun.exe.summon-new from an earlier attempt');
	expect(result.detail).toContain('left unchanged');
	expect(await readFile(join(folder, 'bun.exe'), 'utf8')).toBe('previous copy');
	expect((await readdir(folder)).sort()).toEqual(['bun.exe', 'bun.exe.summon-new']);
	expect(await Bun.file(where.pathStore).exists()).toBe(false);
});

windows('a Bun that cannot take the active name is cleaned up and reported', async () => {
	const where = await use().fixture();
	const folder = join(where.profile, '.bun', 'bin');
	// A folder named bun.exe: the staged copy cannot be renamed onto it.
	await mkdir(join(folder, 'bun.exe'), { recursive: true });
	const result = await helperRun(where, 'install', { id: 'bun' });
	expect(result).toMatchObject({ outcome: 'failed', route: 'fallback' });
	expect(await readdir(folder)).toEqual(['bun.exe']);
	expect(await Bun.file(where.pathStore).exists()).toBe(false);
});

windows(
	'an install Summon still cannot use is reported unverified, naming the PATH copy',
	async () => {
		const where = await use().fixture();
		await writeFile(join(where.search, 'bun.exe'), 'not an executable');
		const result = await helperRun(where, 'install', { id: 'bun' });
		expect(result).toMatchObject({ outcome: 'unverified', route: 'fallback' });
		expect(result.detail).toContain('earlier copy on PATH');
	},
);

windows('a winget success that leaves nothing runnable is reported as unverified', async () => {
	const where = await use().fixture();
	const path = await use().winget(where, 0);
	expect(await helperRun(where, 'install', { id: 'bun', winget: path })).toMatchObject({
		outcome: 'unverified',
		route: 'winget',
	});
});
