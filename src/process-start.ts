import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { requireExecutable } from './executable.ts';
const execute = promisify(execFile);
const snapshots = new Map<number, { expires: number; value: Promise<number | undefined> }>();

async function windowsStart(pid: number): Promise<number | undefined> {
	const { stdout } = await execute(
		requireExecutable('pwsh'),
		[
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			`$p = Get-Process -Id ${pid} -ErrorAction Stop; ([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`,
		],
		{ windowsHide: true, timeout: 5000, maxBuffer: 4096 },
	);
	const value = Number(stdout.trim());
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
