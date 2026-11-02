import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
	powershell,
	powershellRun,
	serveArchives,
	type Transfer,
	zip,
} from './prerequisite-server.ts';

// Drives installer/prerequisites.ps1 under the built-in Windows PowerShell 5.1 it ships for. Every
// runtime the helper probes is a real native .exe (a compiled fixture), run exactly as in production;
// only winget, which the helper starts through ShellExecute, is a .cmd stand-in. Every location is a
// fixture folder and downloads come from a local server: no test installs software, raises UAC,
// accepts agreements or edits the real PATH or registry.
const helper = resolve(import.meta.dir, '../../installer/prerequisites.ps1');

// The native stand-in for bun.exe and pwsh.exe; its behaviour is described in the file itself.
const fixtureSource = resolve(import.meta.dir, 'native-runtime.cs');

export interface Fixture {
	base: string;
	search: string;
	profile: string;
	local: string;
	pathStore: string;
	sources: string;
}

export interface Behaviour {
	output?: string;
	sleep?: number;
	stderr?: number;
	pidfile?: string;
	exit?: number;
}

const helpers = new Set<ReturnType<typeof Bun.spawn>>();

/** Stops and awaits every helper still running (Morgan r4: abandoned cases). */
async function stopHelpers(): Promise<void> {
	for (const child of helpers) child.kill();
	await Promise.all([...helpers].map((child) => child.exited));
}

export async function helperRun(
	where: Fixture,
	mode: 'detect' | 'install',
	options: {
		id?: 'bun' | 'pwsh';
		winget?: string;
		extra?: string[];
		bunMinimum?: string;
		machinePath?: string;
		cwd?: string;
		helperScript?: string;
	} = {},
): Promise<Record<string, string>> {
	const out = join(where.base, `result-${mode}-${options.id ?? 'all'}.txt`);
	const child = Bun.spawn(
		[
			powershell,
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-File',
			options.helperScript ?? helper,
			'-Mode',
			mode,
			...(options.id ? ['-Id', options.id] : []),
			'-SourcesPath',
			where.sources,
			'-BunMinimum',
			options.bunMinimum ?? '1.4.3',
			'-PwshMinimum',
			'7.6.0',
			'-OutFile',
			out,
			'-WingetPath',
			options.winget ?? 'none',
			'-MachinePath',
			options.machinePath ?? where.search,
			'-UserProfileRoot',
			where.profile,
			'-LocalAppDataRoot',
			where.local,
			'-PathStore',
			where.pathStore,
			...(options.extra ?? []),
		],
		{
			cwd: options.cwd ?? where.base,
			stdout: 'pipe',
			stderr: 'pipe',
			stdin: 'ignore',
			windowsHide: true,
			// Inside the runner's 15 s case deadline, so even an ordinary case outlives its helper.
			timeout: 12_000,
		},
	);
	// Registered until it exits, so teardown can stop and await a helper whose case was abandoned.
	helpers.add(child);
	const [code, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	]).finally(() => helpers.delete(child));
	// The never-block rule: the helper itself always exits 0 and reports through its file.
	expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
	const result: Record<string, string> = {};
	for (const line of (await readFile(out, 'utf8')).split(/\r?\n/)) {
		const at = line.indexOf('=');
		if (at > 0) result[line.slice(0, at)] = line.slice(at + 1);
	}
	// The helper's catch-all diagnostic gets its own marked line, independent of how a failing
	// assertion renders, and only in its fixed sanitized shape (Morgan r10).
	if (result.error !== undefined) {
		const shaped =
			/^hresult 0x[0-9A-F]{8} line (\d+|unknown) [a-z-]+ inner 0x[0-9A-F]{8} [a-z-]+$/.test(
				result.error,
			);
		console.log(
			`HELPER-ERROR ${mode} ${options.id ?? 'all'}: ${shaped ? result.error : 'malformed'}`,
		);
	}
	return result;
}

/** One temp root, a compiled native fixture, test archives and a local server per test file. */
export async function createHarness() {
	const root = await mkdtemp(join(tmpdir(), 'summon-prerequisite-helper-'));
	const fixtureExe = join(root, 'fixture.exe');
	await powershellRun(
		`Add-Type -Path '${fixtureSource}' -OutputAssembly '${fixtureExe}' -OutputType ConsoleApplication`,
	);
	const archives = new Map<string, Uint8Array<ArrayBuffer>>();
	const wingetCases: string[] = [];
	// Every sleeping fixture records its PID, so one outliving a killed helper is still waited for.
	const sleepers: string[] = [];
	let requests = 0;

	/** Places the native fixture at <folder>\<name> with the given behaviour. */
	async function runtime(folder: string, name: string, behaviour: Behaviour = {}): Promise<void> {
		await mkdir(folder, { recursive: true });
		await copyFile(fixtureExe, join(folder, name));
		const pidfile = behaviour.pidfile ?? (behaviour.sleep ? join(folder, `${name}.pid`) : '');
		if (behaviour.sleep) sleepers.push(pidfile);
		const lines = [
			behaviour.output ?? '1.4.3',
			...(behaviour.sleep ? [`sleep=${behaviour.sleep}`] : []),
			...(behaviour.stderr ? [`stderr=${behaviour.stderr}`] : []),
			...(pidfile ? [`pidfile=${pidfile}`] : []),
			...(behaviour.exit ? [`exit=${behaviour.exit}`] : []),
		];
		await writeFile(join(folder, `${name}.txt`), `${lines.join('\r\n')}\r\n`);
	}

	const executable = new Uint8Array(await readFile(fixtureExe));
	// The installed Bun has no sidecar, so it prints the fixture's default, 1.4.3.
	archives.set('bun.zip', await zip(root, 'bun', { 'bun-windows-x64/bun.exe': executable }));
	archives.set(
		'pwsh.zip',
		await zip(root, 'pwsh', {
			'pwsh.exe': executable,
			'pwsh.exe.txt': 'PowerShell 7.6.9\r\n',
			'pwsh.dll': 'fixture',
		}),
	);
	const server = serveArchives(archives, () => {
		requests += 1;
	});

	async function fixture(
		options: { bunHash?: string; transfer?: Transfer } = {},
	): Promise<Fixture> {
		const base = await mkdtemp(join(root, 'case-'));
		const port = `http://127.0.0.1:${server.port}`;
		const origin =
			options.transfer === 'offline'
				? 'http://127.0.0.1:9'
				: options.transfer
					? `${port}/${options.transfer}`
					: port;
		const hash = (name: string) =>
			createHash('sha256')
				.update(archives.get(name) ?? new Uint8Array())
				.digest('hex');
		const sources = join(base, 'sources.json');
		await writeFile(
			sources,
			JSON.stringify({
				bun: {
					name: 'Bun',
					winget: 'Oven-sh.Bun',
					wingetScope: 'user',
					fallback: {
						version: '1.4.3',
						url: `${origin}/bun.zip`,
						sha256: options.bunHash ?? hash('bun.zip'),
						executable: 'bun-windows-x64/bun.exe',
					},
				},
				pwsh: {
					name: 'PowerShell',
					winget: 'Microsoft.PowerShell',
					wingetScope: 'machine',
					wingetInstallerType: 'wix',
					fallback: {
						version: '7.6.9',
						url: `${origin}/pwsh.zip`,
						sha256: hash('pwsh.zip'),
						executable: 'pwsh.exe',
					},
				},
			}),
		);
		const folders = {
			search: join(base, 'search'),
			profile: join(base, 'profile'),
			local: join(base, 'local'),
		};
		for (const folder of Object.values(folders)) await mkdir(folder, { recursive: true });
		return { base, ...folders, pathStore: join(base, 'user-path.txt'), sources };
	}

	/** A winget stand-in, started by the helper through ShellExecute: records its arguments, may
	 * place a native runtime as if it had installed one, may wait, then exits with `code`. */
	async function winget(
		where: Fixture,
		code: number,
		options: { installs?: { folder: string; name: string }; waitSeconds?: number } = {},
	): Promise<string> {
		const path = join(where.base, 'winget.cmd');
		const lines = ['@echo off', `echo %*>>"${join(where.base, 'winget-args.txt')}"`];
		if (options.waitSeconds) lines.push(`ping -n ${options.waitSeconds + 1} 127.0.0.1 >nul`);
		if (options.installs) {
			lines.push(`mkdir "${options.installs.folder}" 2>nul`);
			lines.push(
				`copy /y "${fixtureExe}" "${join(options.installs.folder, options.installs.name)}" >nul`,
			);
		}
		// The marker shows this stand-in reached its last step, after the ping it waited on; it is
		// not proof that the CMD process itself has exited.
		lines.push(`echo done>"${join(where.base, 'winget-done.txt')}"`);
		lines.push(`exit /b ${code}`);
		await writeFile(path, `${lines.join('\r\n')}\r\n`);
		wingetCases.push(where.base);
		return path;
	}

	/** Waits until every winget stand-in and sleeping fixture that started has ended (Roger r3 #4). */
	async function settled(limitMs = 30_000): Promise<void> {
		const until = Date.now() + limitMs;
		const running = async (): Promise<boolean> => {
			for (const base of wingetCases)
				if (
					(await Bun.file(join(base, 'winget-args.txt')).exists()) &&
					!(await Bun.file(join(base, 'winget-done.txt')).exists())
				)
					return true;
			for (const pidfile of sleepers) {
				if (!(await Bun.file(pidfile).exists())) continue;
				const pid = Number(await readFile(pidfile, 'utf8'));
				// An empty file is one still being written; never signal PID 0.
				if (!(pid > 0)) return true;
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					// Gone.
				}
			}
			return false;
		};
		while (await running()) {
			if (Date.now() > until) throw new Error('A fixture child did not finish.');
			await Bun.sleep(100);
		}
	}

	return {
		fixture,
		runtime,
		winget,
		settled,
		requests: () => requests,
		async stop(): Promise<void> {
			// The temp root is removed only after every child it holds has ended.
			await stopHelpers();
			await settled();
			await server.stop(true);
			await rm(root, { recursive: true, force: true });
		},
	};
}
