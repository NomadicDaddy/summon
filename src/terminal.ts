import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { platform } from 'node:os';
import { resolve } from 'node:path';

import type { Provider } from './store.ts';

import { executableCommand, requireExecutable, resolveExecutable } from './executable.ts';
import { sessionStorageArguments } from './storage-launch.ts';
import { storageRoot } from './store.ts';
import { assertNonElevated } from './windows-integrity.ts';

export function terminalCommand(
	cliPath: string,
	slug: string,
	provider: Provider,
	cwd: string,
	claudeMailChannel = false,
	newWindow = false,
): string[] | undefined {
	const runner = [process.execPath, cliPath, '__session', slug, ...sessionStorageArguments()];
	if (claudeMailChannel) runner.push('--claude-mail-channel');
	if (platform() === 'win32') {
		const terminal = resolveExecutable('wt.exe');
		if (!terminal) return undefined;
		const root = resolve(storageRoot());
		const windowName = `summon-${createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 16)}`;
		// Root and base arguments also override an existing Terminal window's stale environment.
		return [
			terminal,
			'-w',
			newWindow ? 'new' : windowName,
			'new-tab',
			'--title',
			`${slug} · ${provider}`,
			'--suppressApplicationTitle',
			'--startingDirectory',
			cwd,
			...runner,
		];
	}
	if (platform() === 'darwin') {
		const launcher = resolveExecutable('osascript');
		if (!launcher) return undefined;
		const command = `cd ${shellQuote(cwd)} && exec ${runner.map(shellQuote).join(' ')}`;
		return [
			launcher,
			'-e',
			`tell application "Terminal" to do script "${appleScriptEscape(command)}"`,
		];
	}

	const terminal = linuxTerminal();
	if (!terminal) return undefined;
	return terminal(runner, cwd);
}

export async function openTerminal(command: string[]): Promise<void> {
	await assertNonElevated();
	const child = Bun.spawn({
		cmd: executableCommand(command),
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'ignore',
	});
	child.unref();
}

function linuxTerminal(): ((runner: string[], cwd: string) => string[]) | undefined {
	const emulator = resolveExecutable('x-terminal-emulator');
	if (emulator) {
		return (runner, cwd) => [
			emulator,
			'-e',
			requireExecutable('bash'),
			'-lc',
			`cd ${shellQuote(cwd)} && exec ${runner.map(shellQuote).join(' ')}`,
		];
	}
	const gnome = resolveExecutable('gnome-terminal');
	if (gnome) {
		return (runner, cwd) => [gnome, '--working-directory', cwd, '--', ...runner];
	}
	const konsole = resolveExecutable('konsole');
	if (konsole) {
		return (runner, cwd) => [konsole, '--workdir', cwd, '-e', ...runner];
	}
	return undefined;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function appleScriptEscape(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export async function assertDirectory(path: string): Promise<void> {
	const details = await stat(path).catch(() => undefined);
	if (!details?.isDirectory()) throw new Error(`Working directory does not exist: ${path}`);
}
