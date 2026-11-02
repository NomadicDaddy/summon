import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

import { offlineRuntimeCheck } from './checkpoint-offline-runtime.ts';
import { missing } from './mail-files.ts';

export async function plainMaintenancePath(path: string): Promise<void> {
	for (let current = resolve(path); ; current = dirname(current)) {
		try {
			if ((await lstat(current)).isSymbolicLink())
				throw new Error(`Redirected maintenance path refused: ${current}`);
		} catch (error: unknown) {
			if (!missing(error)) throw error;
		}
		if (dirname(current) === current) break;
	}
}

const snapshotSchema = z.object({
	control: z.literal(true),
	active: z.array(z.object({ pid: z.number().int().positive(), kind: z.string() })),
});

export function verifyOfflineSnapshot(raw: string): void {
	const snapshot = snapshotSchema.parse(JSON.parse(raw) as unknown);
	if (snapshot.active.length)
		throw new Error(
			`Summon is not offline: ${JSON.stringify(snapshot.active)}. Close sessions and windows first.`,
		);
}

// Return only bounded process identity, never command lines or environment values.
export const maintenanceProcessSnapshotCommand = `
$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance Win32_Process -ErrorAction Stop)
$control = @($rows | Where-Object ProcessId -EQ $PID)
if ($control.Count -ne 1 -or -not $control[0].CreationDate -or -not $control[0].ExecutablePath) { throw 'CIM positive control failed; offline state unknown.' }
$active = @($rows | ForEach-Object {
  $kind = if ($_.CommandLine -match '(?i)[\\\\/]dist[\\\\/]team[\\\\/](main|terminal)\\.mjs') { 'Summon window' }
  elseif ($_.CommandLine -match '(?i)(?:^|[\\s"])__session(?:[\\s"]|$)') { 'Named session runner' }
  elseif ($_.Name -in @('electron.exe','bun.exe','summon.exe') -and -not $_.CommandLine) { 'Unverifiable process' }
  else { '' }
  if ($kind) { @{ pid = [int]$_.ProcessId; kind = $kind } }
})
@{ control = $true; active = $active } | ConvertTo-Json -Depth 4 -Compress
`;

export async function requireMaintenanceOffline(home: string): Promise<void> {
	if (process.platform !== 'win32')
		throw new Error('The standing updater currently requires Windows.');
	const child = Bun.spawn(
		['pwsh', '-NoProfile', '-NonInteractive', '-Command', maintenanceProcessSnapshotCommand],
		{
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
			signal: AbortSignal.timeout(15000),
		},
	);
	const [output, , code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error('CIM process inspection failed; offline state is unknown.');
	verifyOfflineSnapshot(output);
	await plainMaintenancePath(home);
	const teams = [home];
	for (const entry of await readdir(home, { withFileTypes: true })) {
		if (!entry.name.startsWith('team-')) continue;
		if (entry.isSymbolicLink()) throw new Error('Linked team storage; offline state unknown.');
		if (entry.isDirectory()) teams.push(join(home, entry.name));
	}
	const check = offlineRuntimeCheck();
	for (const team of teams) {
		const runtime = join(team, 'runtime');
		await plainMaintenancePath(runtime);
		const entries = await readdir(runtime, { withFileTypes: true }).catch((error: unknown) => {
			if (missing(error)) return [];
			throw error;
		});
		for (const entry of entries) {
			if (entry.isSymbolicLink()) throw new Error('Linked runtime; offline state unknown.');
			if (entry.isDirectory()) await check(join(runtime, entry.name));
		}
	}
}
