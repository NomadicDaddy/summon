import { resolve } from 'node:path';

/** Match both the shipped main program and the exact team-root argument, not a root prefix. */
export function isBackfillTeamWindow(commandLine: string, root: string): boolean {
	const command = commandLine.replaceAll('\\', '/').toLowerCase();
	const target = resolve(root).replaceAll('\\', '/').toLowerCase();
	const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return (
		/\/dist\/team\/main\.mjs(?=["\s]|$)/.test(command) &&
		new RegExp(`(?:^|["\\s])${escaped}(?=["\\s]|$)`).test(command)
	);
}

/** Actual process inventory, with the inventory reader itself as the known-positive control. */
export async function assertBackfillWindowOffline(root: string): Promise<void> {
	if (process.platform !== 'win32')
		throw new Error('This reviewed backfill procedure requires the Windows operator terminal.');
	const script = String.raw`
$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance Win32_Process -ErrorAction Stop)
$control = @($rows | Where-Object ProcessId -eq $PID)
if ($control.Count -ne 1 -or -not $control[0].CommandLine) { throw 'Process inventory control failed' }
$windows = @($rows | Where-Object {
    $_.CommandLine -match '(?i)[\\/]+dist[\\/]+team[\\/]+main\.mjs(?:[\s"]|$)'
} | ForEach-Object { @{pid=$_.ProcessId; commandLine=$_.CommandLine} })
$unknown = @($rows | Where-Object {
    $_.Name -eq 'electron.exe' -and -not $_.CommandLine
} | ForEach-Object { $_.ProcessId })
@{controlPassed=$true; windows=$windows; unknownWindows=$unknown} | ConvertTo-Json -Depth 4 -Compress
`;
	const child = Bun.spawn(['pwsh', '-NoProfile', '-NonInteractive', '-Command', script], {
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	});
	const [code, output] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0) throw new Error('Team Window process inventory could not be verified.');
	const value: unknown = JSON.parse(output);
	if (
		!value ||
		typeof value !== 'object' ||
		!('controlPassed' in value) ||
		value.controlPassed !== true ||
		!('windows' in value) ||
		!Array.isArray(value.windows) ||
		!('unknownWindows' in value) ||
		!Array.isArray(value.unknownWindows) ||
		value.unknownWindows.length
	)
		throw new Error('Team Window process inventory is incomplete or unverifiable.');
	for (const candidate of value.windows as unknown[]) {
		if (
			!candidate ||
			typeof candidate !== 'object' ||
			!('commandLine' in candidate) ||
			typeof candidate.commandLine !== 'string'
		)
			throw new Error('Team Window process inventory is invalid.');
		if (isBackfillTeamWindow(candidate.commandLine, root))
			throw new Error(
				'This team window is still running. Close it before applying the Diary batch; no process was stopped.',
			);
	}
}
