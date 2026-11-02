import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function assertMediumIntegrity(groups: string): void {
	// SID numbers are stable across display languages. Administrator group membership
	// alone is insufficient: a filtered, non-elevated administrator has a Medium token.
	const levels = [...groups.matchAll(/\bS-1-16-(\d+)\b/g)];
	const level = Number(levels[0]?.[1]);
	if (levels.length !== 1 || !Number.isSafeInteger(level))
		throw new Error('Cannot verify Windows integrity level. No session was launched.');
	if (level >= 12_288)
		throw new Error(
			'Summon blocked an elevated (Administrator) launch. Agents would inherit administrator rights without a UAC prompt. Open a normal, non-administrator terminal and run summon there. The existing Team Window was not changed.',
		);
	if (level !== 8192)
		throw new Error('Summon requires Windows Medium integrity. Open a normal terminal.');
}

export async function assertNonElevated(): Promise<void> {
	if (process.platform !== 'win32') return;
	let groups: string;
	try {
		// Do not resolve GNU whoami from PATH, or interpolate a command into a shell.
		const result = await execute(
			join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'),
			['/groups', '/fo', 'csv'],
			{ windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024, encoding: 'utf8' },
		);
		groups = result.stdout;
	} catch {
		throw new Error('Cannot verify Windows integrity level. No session was launched.');
	}
	assertMediumIntegrity(groups);
}
