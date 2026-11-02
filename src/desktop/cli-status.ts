import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import type { Provider } from '../store.ts';

import { requireExecutable, resolveExecutable } from '../executable.ts';
import { providerLabels } from './provider-labels.ts';
import { killProcessTree } from './pty-process.ts';

export interface CliStatus {
	provider: Provider;
	status: 'available' | 'missing' | 'unavailable';
	detail: string;
}

export async function cliStatuses(): Promise<CliStatus[]> {
	return Promise.all(
		(Object.keys(providerLabels) as Provider[]).map(async (provider) => {
			const executable = resolveExecutable(provider);
			if (!executable)
				return { provider, status: 'missing' as const, detail: 'Not found on PATH' };
			if (process.platform === 'win32' && /["%!\r\n]/.test(executable))
				return {
					provider,
					status: 'unavailable' as const,
					detail: 'Unsafe version-check path',
				};
			return new Promise<CliStatus>((resolve) => {
				// Both the executable and arguments are fixed application-owned values.
				const command =
					process.platform === 'win32'
						? requireExecutable(
								join(
									process.env.SystemRoot ?? 'C:\\Windows',
									'System32',
									'cmd.exe',
								),
							)
						: executable;
				const args =
					process.platform === 'win32'
						? ['/d', '/s', '/c', `""${executable}" --version"`]
						: ['--version'];
				const child = execFile(
					command,
					args,
					{
						windowsHide: true,
						windowsVerbatimArguments: process.platform === 'win32',
						maxBuffer: 16384,
					},
					(error, stdout, stderr) => {
						clearTimeout(timer);
						const line = stripVTControlCharacters(`${stdout}\n${stderr}`)
							.split(/\r?\n/)
							.find((value) => /\d/.test(value));
						resolve({
							provider,
							status: error ? 'unavailable' : 'available',
							detail: error
								? 'Version check failed or timed out'
								: (line?.slice(0, 160) ?? 'Version not reported'),
						});
					},
				);
				const timer = setTimeout(() => {
					if (process.platform === 'win32' && child.pid)
						void killProcessTree(child.pid, () => child.exitCode !== null).catch(() =>
							child.kill('SIGKILL'),
						);
					else child.kill('SIGKILL');
				}, 5000);
			});
		}),
	);
}
