import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { ShellChoice } from './types.ts';

import { resolveExecutable } from '../executable.ts';
export interface ShellDefinition extends ShellChoice {
	path: string;
	args: string[];
}

function which(name: string): string | undefined {
	return resolveExecutable(name);
}

export async function detectShells(): Promise<ShellDefinition[]> {
	const shells: ShellDefinition[] = [];
	const add = (id: string, label: string, path: string | undefined, args: string[]): void => {
		const executable = path ? resolveExecutable(path) : undefined;
		if (executable) shells.push({ id, label, path: executable, args });
	};
	if (process.platform !== 'win32') {
		for (const name of ['bash', 'zsh', 'sh']) add(name, name, which(name), ['-i']);
		return shells;
	}
	add('pwsh', 'PowerShell 7', which('pwsh.exe'), ['-NoLogo']);
	add('cmd', 'Command Prompt', resolveExecutable(process.env.COMSPEC ?? 'cmd.exe'), []);
	const git = which('git.exe');
	const bash = [
		...(git ? [join(dirname(dirname(git)), 'bin', 'bash.exe')] : []),
		join(process.env.ProgramFiles ?? '', 'Git', 'bin', 'bash.exe'),
	].find((path) => existsSync(path));
	add('git-bash', 'Git Bash', bash, ['-i']);
	const wsl = which('wsl.exe');
	if (wsl) {
		try {
			const { stdout } = await promisify(execFile)(wsl, ['-l', '-q'], {
				encoding: 'buffer',
				windowsHide: true,
				timeout: 5000,
			});
			for (const name of stdout
				.toString('utf16le')
				.split(/\r?\n/)
				.map((s) => s.trim())) {
				if (
					!name ||
					['docker-desktop', 'docker-desktop-data', 'rancher-desktop'].includes(
						name.toLowerCase(),
					)
				)
					continue;
				add(`wsl-${name.toLowerCase()}`, `WSL (${name})`, wsl, ['-d', name]);
			}
		} catch {
			// WSL can be installed without any available user distributions.
		}
	}
	return shells;
}
