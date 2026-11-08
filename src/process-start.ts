import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { requireExecutable } from './executable.ts';
const execute = promisify(execFile);
const snapshots = new Map<number, { expires: number; value: Promise<number | undefined> }>();

async function queryWindowsStart(script: string): Promise<string> {
	const { stdout } = await execute(
		requireExecutable('pwsh'),
		['-NoProfile', '-NonInteractive', '-Command', script],
		{ windowsHide: true, timeout: 5000, maxBuffer: 4096 },
	);
	return stdout;
}

export async function windowsStart(
	pid: number,
	query: (script: string) => Promise<string> = queryWindowsStart,
): Promise<number | undefined> {
	const script = [
		`$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop`,
		"if ($null -eq $p -or $null -eq $p.CreationDate) { throw 'Process start unavailable' }",
		'([DateTimeOffset]$p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()',
	].join('; ');
	const value = Number((await query(script)).trim());
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Missing or inaccessible process evidence never authorizes reclaiming a live PID. */
export async function startedAfterLock(pid: number, writtenAt: number): Promise<boolean> {
	if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return false;
	const now = Date.now();
	for (const [key, entry] of snapshots) if (entry.expires <= now) snapshots.delete(key);
	let snapshot = snapshots.get(pid);
	if (!snapshot) {
		snapshot = { expires: now + 1000, value: windowsStart(pid).catch(() => undefined) };
		snapshots.set(pid, snapshot);
	}
	const started = await snapshot.value;
	return started !== undefined && started > writtenAt;
}
