import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { offlineRuntimeCheck } from './checkpoint-offline-runtime.ts';
import { missing } from './mail-files.ts';
import {
	maintenanceProcessSnapshotCommand,
	plainMaintenancePath,
	verifyOfflineSnapshot,
} from './maintenance-offline.ts';
import { assertOfflineProcesses } from './offline-processes.ts';

/**
 * Fail closed before an offline state migration of one team: both process inventories (the
 * command-line match and the CIM snapshot with its positive control and unverifiable processes),
 * no linked path to the team, its runtime or the target file, and no runtime owner, receiver or
 * session lease that is not provably ended.
 */
export async function assertOfflineTeam(root: string, target: string): Promise<void> {
	await assertOfflineProcesses();
	const child = Bun.spawn(
		['pwsh', '-NoProfile', '-NonInteractive', '-Command', maintenanceProcessSnapshotCommand],
		{ stdout: 'pipe', stderr: 'pipe', windowsHide: true, signal: AbortSignal.timeout(15000) },
	);
	const [output, , code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error('CIM process inspection failed; migration refused.');
	verifyOfflineSnapshot(output);
	await assertOfflineTeamFiles(root, target);
}

/** The file half: no linked path, and no runtime owner, receiver or session lease still live. */
export async function assertOfflineTeamFiles(root: string, target: string): Promise<void> {
	await plainMaintenancePath(target);
	const runtime = join(root, 'runtime');
	await plainMaintenancePath(runtime);
	const check = offlineRuntimeCheck();
	const entries = await readdir(runtime, { withFileTypes: true }).catch((error: unknown) => {
		if (missing(error)) return [];
		throw error;
	});
	for (const entry of entries) {
		if (entry.isSymbolicLink()) throw new Error('Linked runtime owner; migration refused.');
		if (entry.isDirectory()) await check(join(runtime, entry.name));
	}
}
