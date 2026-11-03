import { afterAll, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { installerLauncher } from '../scripts/installer-launcher.ts';

const root = await mkdtemp(join(tmpdir(), 'summon launcher fixture ! '));
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});
const windows = process.platform === 'win32' ? test : test.skip;
const realExe = async (path: string) => (await realpath(path)).toLowerCase();
// The launcher's fallback folders must come from the fixture, never this host's real profile.
const emptyProfile = join(root, 'empty profile');
const emptyLocalAppData = join(root, 'empty local app data');

async function launch(
	path: string,
	args = '',
	profile = { USERPROFILE: emptyProfile, LOCALAPPDATA: emptyLocalAppData },
	cwd = root,
	extra: Record<string, string> = {},
	entry = join(root, 'summon.cmd'),
) {
	// A Windows environment has one case-insensitive key per name; do not synthesize duplicates.
	const replaced = new Set(['path', 'userprofile', 'localappdata', 'summon_path']);
	const environment: Record<string, string | undefined> = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !replaced.has(name.toLowerCase())),
	);
	environment.PATH = path;
	environment.USERPROFILE = profile.USERPROFILE;
	environment.LOCALAPPDATA = profile.LOCALAPPDATA;
	Object.assign(environment, extra);
	const child = Bun.spawn(
		[
			join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/cmd.exe'),
			'/d',
			'/s',
			'/c',
			`""${entry}" ${args}"`,
		],
		{
			cwd,
			env: environment,
			windowsVerbatimArguments: true,
			windowsHide: true,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}

windows(
	'actual generated CMD refuses missing Bun, ignores working-folder executable and gives official guidance',
	async () => {
		await writeFile(join(root, 'summon.cmd'), installerLauncher('fixture'));
		// This local fixture copy is never packaged or distributed.
		await copyFile(process.execPath, join(root, 'bun.exe'));
		const result = await launch(join(root, 'empty PATH directory'));
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Bun 1.4.3');
		expect(result.stderr).toContain('https://bun.com/docs/installation');
		expect(result.stdout).toBe('');
	},
);

windows(
	'actual generated CMD uses PATH Bun, preserves spaced paths/arguments and propagates CLI failure',
	async () => {
		const app = join(root, 'versions/fixture/app');
		for (const directory of ['scripts', 'src'])
			await mkdir(join(app, directory), { recursive: true });
		for (const file of ['scripts/installed-launch.ts', 'src/runtime-prerequisites.ts'])
			await writeFile(join(app, file), await readFile(resolve(import.meta.dir, '..', file)));
		await writeFile(
			join(app, 'src/cli.ts'),
			`console.log(JSON.stringify({ args: process.argv.slice(2), path: process.env.PATH })); process.exit(37);`,
		);
		await writeFile(join(root, 'summon.cmd'), installerLauncher('fixture'));
		const result = await launch(dirname(process.execPath), '--fixture "two words"');
		expect(result.code).toBe(37);
		const observed = JSON.parse(result.stdout.trim()) as { args: string[]; path: string };
		expect(observed.args).toEqual(['--fixture', 'two words']);
		expect(observed.path.split(';')[0]?.replace(/[\\/]$/, '')).toBe(root);
		expect(result.stderr).toBe('');
	},
);

async function fallbackApp(): Promise<void> {
	const app = join(root, 'versions/fixture/app');
	for (const directory of ['scripts', 'src'])
		await mkdir(join(app, directory), { recursive: true });
	for (const file of ['scripts/installed-launch.ts', 'src/runtime-prerequisites.ts'])
		await writeFile(join(app, file), await readFile(resolve(import.meta.dir, '..', file)));
	await writeFile(join(app, 'src/cli.ts'), `console.log('fallback-bun-ran'); process.exit(0);`);
	await writeFile(join(root, 'summon.cmd'), installerLauncher('fixture'));
}

for (const [label, folder] of [
	['Bun per-user folder', (base: string) => join(base, 'profile', '.bun', 'bin')],
	['winget Links folder', (base: string) => join(base, 'local', 'Microsoft', 'WinGet', 'Links')],
] as const)
	windows(`actual generated CMD finds Bun in the ${label} when PATH is stale`, async () => {
		await fallbackApp();
		const base = await mkdtemp(join(root, 'fallback '));
		await mkdir(folder(base), { recursive: true });
		// This local fixture copy is never packaged or distributed.
		await copyFile(process.execPath, join(folder(base), 'bun.exe'));
		const result = await launch(join(root, 'empty PATH directory'), '', {
			USERPROFILE: join(base, 'profile'),
			LOCALAPPDATA: join(base, 'local'),
		});
		expect(result.stdout.trim()).toBe('fallback-bun-ran');
		expect(result.code).toBe(0);
	});

// The pair below is the launch half of one rule; installer-prerequisites-detect.test.ts holds the
// setup half, where the same arrangement reports this Bun as unreadable, never found.
windows(
	'actual generated CMD uses the first Bun that exists, never a later current one',
	async () => {
		await fallbackApp();
		const base = await mkdtemp(join(root, 'first copy '));
		// First on PATH and not a runnable Bun: the launcher must not skip past it.
		await mkdir(join(base, 'path'), { recursive: true });
		await writeFile(join(base, 'path', 'bun.exe'), 'not an executable');
		const current = join(base, 'profile', '.bun', 'bin');
		await mkdir(current, { recursive: true });
		// This local fixture copy is never packaged or distributed.
		await copyFile(process.execPath, join(current, 'bun.exe'));
		const result = await launch(join(base, 'path'), '', {
			USERPROFILE: join(base, 'profile'),
			LOCALAPPDATA: join(base, 'local'),
		});
		expect(result.code).not.toBe(0);
		expect(result.stdout).not.toContain('fallback-bun-ran');
	},
);

windows('actual generated CMD never searches a relative PATH entry', async () => {
	await fallbackApp();
	const started = await mkdtemp(join(root, 'started from '));
	await mkdir(join(started, 'relative'), { recursive: true });
	// A runnable Bun under the working folder, reachable only through the relative entry.
	// This local fixture copy is never packaged or distributed.
	await copyFile(process.execPath, join(started, 'relative', 'bun.exe'));
	const result = await launch('relative', '', undefined, started);
	expect(result.stdout).not.toContain('fallback-bun-ran');
	expect(result.code).toBe(1);
	expect(result.stderr).toContain('Bun 1.4.3');
});

// The launch half of setup's absolute-only PATH policy (Roger r4): relative entries, wherever they
// would resolve, and a folder named bun.exe are passed over; the first qualified copy is the one run.
windows(
	'actual generated CMD runs the first fully qualified PATH Bun, skipping relative entries',
	async () => {
		await fallbackApp();
		const app = join(root, 'versions/fixture/app');
		await writeFile(join(app, 'src/cli.ts'), `console.log(process.execPath); process.exit(0);`);
		const started = await mkdtemp(join(root, 'winning copy '));
		const wins = join(started, 'qualified copy');
		// Runnable Bun copies the relative entries would reach, from the working folder or its parent.
		// These local fixture copies are never packaged or distributed.
		for (const folder of [join(started, 'relative'), join(started, '..', 'up'), wins]) {
			await mkdir(folder, { recursive: true });
			await copyFile(process.execPath, join(folder, 'bun.exe'));
		}
		await mkdir(join(started, 'folder named bun', 'bun.exe'), { recursive: true });
		const path = `relative;..\\up;${join(started, 'folder named bun')};"${wins}"`;
		const result = await launch(path, '', undefined, started);
		expect(await realExe(result.stdout.trim())).toBe(await realExe(join(wins, 'bun.exe')));
		expect(result.code).toBe(0);
	},
);

// setlocal keeps inherited variables, so a stray SUMMON_PATH must never become the search list.
windows(
	'actual generated CMD never searches an inherited SUMMON_PATH when PATH is absent',
	async () => {
		await fallbackApp();
		const stray = await mkdtemp(join(root, 'stray summon path '));
		// This local fixture copy is never packaged or distributed.
		await copyFile(process.execPath, join(stray, 'bun.exe'));
		// Bun.spawn cannot be relied on to leave PATH out, so a wrapper clears it in CMD itself and
		// proves the premise before the launcher runs (r9 s4: PATH was evidently still defined).
		const wrapper = join(stray, 'no path.cmd');
		await writeFile(
			wrapper,
			[
				'@echo off',
				'set "PATH="',
				'if not defined PATH echo PATH-ABSENT',
				`call "${join(root, 'summon.cmd')}" %*`,
				'',
			].join('\r\n'),
		);
		const result = await launch('', '', undefined, root, { SUMMON_PATH: stray }, wrapper);
		expect(result.stdout).toContain('PATH-ABSENT');
		expect(result.stdout).not.toContain('fallback-bun-ran');
		// Code, guidance and stderr together: a failure shows what CMD printed (r10c measured 255).
		const { code, stderr } = result;
		expect({ code, guidance: stderr.includes('Bun 1.4.3'), stderr }).toMatchObject({
			code: 1,
			guidance: true,
		});
	},
);

// Setup judges the saved PATH that new programs receive; a terminal opened before setup keeps its
// inherited PATH. That terminal's Bun is the one run, which is why setup, the docs and the refusal
// text all say to open a new terminal (Morgan r4 High). This pins the behaviour they describe.
windows(
	'actual generated CMD uses the inherited PATH, not a Bun setup placed after it started',
	async () => {
		await fallbackApp();
		const app = join(root, 'versions/fixture/app');
		await writeFile(join(app, 'src/cli.ts'), `console.log(process.execPath); process.exit(0);`);
		const base = await mkdtemp(join(root, 'inherited '));
		const inherited = join(base, 'older copy');
		const installed = join(base, 'profile', '.bun', 'bin');
		// These local fixture copies are never packaged or distributed.
		for (const folder of [inherited, installed]) {
			await mkdir(folder, { recursive: true });
			await copyFile(process.execPath, join(folder, 'bun.exe'));
		}
		const result = await launch(inherited, '', {
			USERPROFILE: join(base, 'profile'),
			LOCALAPPDATA: join(base, 'local'),
		});
		expect(await realExe(result.stdout.trim())).toBe(await realExe(join(inherited, 'bun.exe')));
	},
);

windows(
	'actual generated CMD still reports missing Bun when no fallback folder has it',
	async () => {
		await fallbackApp();
		const base = await mkdtemp(join(root, 'no fallback '));
		// Folders exist but hold no bun.exe: existence of the folder alone must not count.
		await mkdir(join(base, 'profile', '.bun', 'bin'), { recursive: true });
		await mkdir(join(base, 'local', 'Microsoft', 'WinGet', 'Links'), { recursive: true });
		const result = await launch(join(root, 'empty PATH directory'), '', {
			USERPROFILE: join(base, 'profile'),
			LOCALAPPDATA: join(base, 'local'),
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Bun 1.4.3');
		expect(result.stdout).not.toContain('fallback-bun-ran');
	},
);

test('launcher cannot insert runtime directories or executable build text', () => {
	expect(installerLauncher('0.32.17-abcd')).not.toMatch(/runtime\\(?:bun|pwsh)|powershell\.exe/i);
	expect(() => installerLauncher('bad&echo injected')).toThrow('Invalid installer build ID');
});

test('installed entry refuses old and unverifiable Bun before importing its CLI consumer', async () => {
	const app = join(root, 'old-version/app');
	for (const directory of ['scripts', 'src'])
		await mkdir(join(app, directory), { recursive: true });
	await writeFile(join(app, 'src/cli.ts'), `throw new Error('CLI must not be imported');`);
	await copyFile(
		resolve(import.meta.dir, '../src/runtime-prerequisites.ts'),
		join(app, 'src/runtime-prerequisites.ts'),
	);
	const entry = await readFile(
		resolve(import.meta.dir, '../scripts/installed-launch.ts'),
		'utf8',
	);
	expect(entry.match(/Bun\.version/g)?.length).toBe(1);
	// Control only the version read in an ephemeral entry copy; Bun.version itself is immutable.
	// This exercises the entry's failure/import boundary, not an acquired old runtime binary.
	for (const version of ['1.4.2', '1.4.3-canary']) {
		await writeFile(
			join(app, 'scripts/installed-launch.ts'),
			entry.replace('Bun.version', JSON.stringify(version)),
		);
		const child = Bun.spawn([process.execPath, join(app, 'scripts/installed-launch.ts')], {
			stdout: 'pipe',
			stderr: 'pipe',
			stdin: 'ignore',
			windowsHide: true,
		});
		const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(code).toBe(1);
		expect(stderr).toContain('Summon cannot start:');
		expect(stderr).toContain('https://bun.com/docs/installation');
		expect(stderr).toContain('open a new terminal or start Summon from Start');
		expect(stderr).not.toContain('CLI must not be imported');
	}
});
