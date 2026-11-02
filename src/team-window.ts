import { closeSync, openSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { assertElectronRuntime } from './electron-runtime.ts';
import { operatorOnly } from './mail-identity.ts';
import { operatorScratchExpiry } from './scratch-retention.ts';
import { prepareStorageLayout } from './storage-layout.ts';
import { selectedTeamsBase, standaloneBaseArgument } from './storage-root.ts';
import { storageRoot } from './store.ts';
import { assertTeamBuildLayout } from './team-build-layout.ts';
import { teamDist } from './team-build-options.ts';
import { buildTeam } from './team-build.ts';
import { teamWindowRuntime } from './team-startup.ts';
import { assertNonElevated } from './windows-integrity.ts';

export async function pruneTeamLogs(runtime: string): Promise<void> {
	const entries = (await readdir(runtime, { withFileTypes: true })).filter(
		(entry) => entry.isFile() && /^launch-[a-f0-9-]+\.log$/.test(entry.name),
	);
	const logs = await Promise.all(
		entries.map(async (entry) => {
			const path = resolve(runtime, entry.name);
			return { path, modified: (await stat(path)).mtimeMs };
		}),
	);
	logs.sort(
		(left, right) => right.modified - left.modified || left.path.localeCompare(right.path),
	);
	for (const log of logs.slice(5)) await rm(log.path, { force: true });
}

export async function openTeam(): Promise<void> {
	operatorOnly();
	await assertNonElevated();
	await prepareStorageLayout();
	await operatorScratchExpiry();
	if (!(await Bun.file(resolve(teamDist, 'main.mjs')).exists())) await buildTeam();
	await assertTeamBuildLayout();
	const electron: unknown = (await import('electron')).default;
	if (typeof electron !== 'string') throw new Error('Electron executable is unavailable.');
	await assertElectronRuntime(dirname(Bun.resolveSync('electron/package.json', import.meta.dir)));
	const runtime = resolve(teamWindowRuntime());
	await mkdir(runtime, { recursive: true, mode: 0o700 });
	const receipt = resolve(runtime, `launch-${crypto.randomUUID()}.json`);
	const log = receipt.replace('.json', '.log');
	const output = openSync(log, 'a');
	console.log('Opening summon team window…');
	try {
		const child = Bun.spawn({
			cmd: [
				electron,
				resolve(teamDist, 'main.mjs'),
				resolve(storageRoot()),
				process.execPath,
				resolve(import.meta.dir, 'cli.ts'),
				selectedTeamsBase() ?? standaloneBaseArgument,
				receipt,
			],
			stdin: 'ignore',
			detached: true,
			stdout: output,
			stderr: output,
		});
		const deadline = Date.now() + 15_000;
		while (!(await Bun.file(receipt).exists())) {
			if (child.exitCode !== null || Date.now() >= deadline) {
				if (child.exitCode === null) child.kill();
				throw new Error(`Team window did not become ready. Launch details: ${log}`);
			}
			await Bun.sleep(50);
		}
		child.unref();
		await pruneTeamLogs(runtime).catch((error: unknown) => {
			console.error(
				`Team window log cleanup: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		console.log('Summon team window ready. Closing it stops the sessions it owns.');
	} finally {
		closeSync(output);
		await rm(receipt, { force: true });
	}
}
