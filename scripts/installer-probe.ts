import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { runtimeVersionStatus } from '../src/runtime-prerequisites.ts';

export async function installerProbe(payload: string) {
	if (runtimeVersionStatus('bun', Bun.version).status !== 'available')
		throw new Error(
			'Installer checks require a separately installed stable Bun 1.4.3 or later.',
		);
	const root = resolve(import.meta.dir, '../dist/installer-checks', crypto.randomUUID());
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
		SUMMON_TEAMS_HOME: join(root, 'store'),
	};
	environment.Path = environment.PATH;
	// Isolate only the disposable child; never change the invoking named session.
	delete environment.SUMMON_AGENT;
	delete environment.SUMMON_NONCE;
	delete environment.SUMMON_HOME;
	await mkdir(environment.SUMMON_TEAMS_HOME ?? '', { recursive: true });
	async function probe(command: string[], expected: string): Promise<void> {
		const child = Bun.spawn(command, {
			cwd: payload,
			env: environment,
			windowsHide: true,
			stdout: 'pipe',
			stderr: 'pipe',
			stdin: 'ignore',
		});
		const timeout = setTimeout(() => child.kill(), 30_000);
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			await writeFile(
				join(root, `${crypto.randomUUID()}.json`),
				JSON.stringify({ command, expected, stdout, stderr, code }),
			);
			if (code !== 0 || !stdout.includes(expected))
				throw new Error(`Payload probe failed (${code}): ${stderr}\n${stdout}`);
		} finally {
			clearTimeout(timeout);
		}
	}
	return { root, environment, probe };
}
