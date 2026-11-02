import { expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { executableCommand, requireExecutable, resolveExecutable } from '../src/executable.ts';

test('lookup ignores empty and relative PATH entries and fails closed for missing programs', () => {
	expect(
		resolveExecutable('not-a-real-summon-tool', { PATH: `.${delimiter}${delimiter}bin` }),
	).toBeUndefined();
	expect(resolveExecutable('./tool', { PATH: process.cwd() })).toBeUndefined();
	expect(resolveExecutable('C:tool', { PATH: process.cwd() })).toBeUndefined();
	if (process.platform === 'win32')
		expect(resolveExecutable('tool', { PATH: '\\relative-to-drive' })).toBeUndefined();
	expect(() => executableCommand(['not-a-real-summon-tool'], { PATH: '' })).toThrow(
		'no program launched',
	);
	expect(executableCommand([process.execPath, '--version'], { PATH: '' })).toEqual([
		process.execPath,
		'--version',
	]);
	if (process.platform === 'win32')
		expect(
			resolveExecutable(basename(process.execPath), {
				Path: dirname(process.execPath),
				PathExt: '.EXE',
			}),
		).toBe(process.execPath);
});

test('Windows launch and version probe ignore planted cwd EXE/CMD with the OS mitigation absent', async () => {
	if (process.platform !== 'win32') return;
	const root = await mkdtemp(join(tmpdir(), 'summon-executable-'));
	try {
		const bin = join(root, 'trusted bin tools');
		const cwd = join(root, 'downloaded repository');
		await mkdir(bin);
		await mkdir(cwd);
		for (const directory of [bin, cwd]) {
			await copyFile(process.execPath, join(directory, 'probe.exe'));
			await writeFile(
				join(directory, 'claude.cmd'),
				`@echo off\r\necho claude ${directory === bin ? '1.2.3' : '9.9.9-SHADOW'}\r\n`,
			);
		}
		const script = join(root, 'run.ts');
		await writeFile(
			script,
			`
import { executableCommand } from ${JSON.stringify(resolve('src/executable.ts'))};
import { cliStatuses } from ${JSON.stringify(resolve('src/desktop/cli-status.ts'))};
delete process.env.NoDefaultCurrentDirectoryInExePath;
const run = (cmd) => Bun.spawnSync(cmd, { cwd: ${JSON.stringify(cwd)}, env: process.env }).stdout.toString().trim();
const args = ['probe', '-e', 'process.stdout.write(process.execPath)'];
console.log(JSON.stringify({
 raw: run(args), safe: run(executableCommand(args)),
 shimRaw: run(['claude']), shimSafe: run(executableCommand(['claude'])),
 statuses: await cliStatuses(),
}));
`,
		);
		const child = Bun.spawn([process.execPath, script], {
			cwd,
			env: {
				PATH: bin,
				PATHEXT: '.EXE;.CMD',
				SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
				SUMMON_HOME: join(root, 'store'),
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [code, out, error] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(error).toBe('');
		expect(code).toBe(0);
		const result = JSON.parse(out) as {
			raw: string;
			safe: string;
			shimRaw: string;
			shimSafe: string;
			statuses: { provider: string; status: string; detail: string }[];
		};
		// Positive controls establish that this host actually searches cwd without the mitigation.
		// Compare identities: the launched path may be spelled long while a short-form TEMP is not.
		const planted = (await realpath(join(cwd, 'probe.exe'))).toLowerCase();
		const trusted = (await realpath(join(bin, 'probe.exe'))).toLowerCase();
		const identity = async (path: string): Promise<string> =>
			(await realpath(path)).toLowerCase();
		expect(await identity(result.raw)).toBe(planted);
		expect(result.shimRaw).toContain('SHADOW');
		expect(await identity(result.safe)).toBe(trusted);
		expect(result.shimSafe).toBe('claude 1.2.3');
		expect(result.statuses.find((entry) => entry.provider === 'claude')).toEqual({
			provider: 'claude',
			status: 'available',
			detail: 'claude 1.2.3',
		});
		// The Electron main process uses real Node, not Bun's child_process implementation.
		const nodeScript = join(root, 'node-run.mjs');
		await writeFile(
			nodeScript,
			`
import { spawnSync } from 'node:child_process';
import { executableCommand } from ${JSON.stringify(pathToFileURL(resolve('src/executable.ts')).href)};
import { cliStatuses } from ${JSON.stringify(pathToFileURL(resolve('src/desktop/cli-status.ts')).href)};
delete process.env.NoDefaultCurrentDirectoryInExePath;
const args = ['probe', '-e', 'process.stdout.write(process.execPath)'];
const run = (cmd) => spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8' }).stdout.trim();
console.log(JSON.stringify({ raw: run(args), safe: run(executableCommand(args)), statuses: await cliStatuses() }));
`,
		);
		const node = Bun.spawn([requireExecutable('node'), nodeScript], {
			cwd,
			env: {
				PATH: bin,
				PATHEXT: '.EXE;.CMD',
				SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [nodeCode, nodeOut, nodeError] = await Promise.all([
			node.exited,
			new Response(node.stdout).text(),
			new Response(node.stderr).text(),
		]);
		expect(nodeError).toBe('');
		expect(nodeCode).toBe(0);
		const nodeResult = JSON.parse(nodeOut) as typeof result;
		expect(await identity(nodeResult.raw)).toBe(planted);
		expect(await identity(nodeResult.safe)).toBe(trusted);
		expect(nodeResult.statuses.find((entry) => entry.provider === 'claude')).toEqual({
			provider: 'claude',
			status: 'available',
			detail: 'claude 1.2.3',
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
