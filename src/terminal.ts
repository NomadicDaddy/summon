import { platform } from 'node:os';
import type { Provider } from './store.ts';

export function terminalCommand(
	cliPath: string,
	slug: string,
	provider: Provider,
	cwd: string,
): string[] | undefined {
	const runner = [process.execPath, cliPath, '__session', slug];
	if (platform() === 'win32') {
		return [
			'wt.exe',
			'-w',
			'new',
			'new-tab',
			'--title',
			`${slug} · ${provider}`,
			'--startingDirectory',
			cwd,
			...runner,
		];
	}
	if (platform() === 'darwin') {
		const command = `cd ${shellQuote(cwd)} && exec ${runner.map(shellQuote).join(' ')}`;
		return [
			'osascript',
			'-e',
			`tell application "Terminal" to do script "${appleScriptEscape(command)}"`,
		];
	}

	const terminal = linuxTerminal();
	if (!terminal) return undefined;
	return terminal(runner, cwd);
}

export function openTerminal(command: string[]): void {
	const child = Bun.spawn({
		cmd: command,
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'ignore',
	});
	child.unref();
}

function linuxTerminal(): ((runner: string[], cwd: string) => string[]) | undefined {
	if (Bun.which('x-terminal-emulator')) {
		return (runner, cwd) => [
			'x-terminal-emulator',
			'-e',
			'bash',
			'-lc',
			`cd ${shellQuote(cwd)} && exec ${runner.map(shellQuote).join(' ')}`,
		];
	}
	if (Bun.which('gnome-terminal')) {
		return (runner, cwd) => ['gnome-terminal', '--working-directory', cwd, '--', ...runner];
	}
	if (Bun.which('konsole')) {
		return (runner, cwd) => ['konsole', '--workdir', cwd, '-e', ...runner];
	}
	return undefined;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function appleScriptEscape(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
