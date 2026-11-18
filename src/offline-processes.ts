/** Refuse an offline migration while any Summon window, session or receiver process is present. */
export async function assertOfflineProcesses(): Promise<void> {
	if (process.platform !== 'win32')
		throw new Error('This offline migration requires the Windows operator terminal.');
	const script =
		'Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match "(?i)(dist[\\/]+team[\\/]+main|summon.*(?:__session|--team)|src[\\/]+cli\\.ts.*__session)" } | ForEach-Object { $_.ProcessId } | ConvertTo-Json -Compress';
	const child = Bun.spawn({
		cmd: ['pwsh', '-NoProfile', '-NonInteractive', '-Command', script],
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	});
	const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	await new Response(child.stderr).text();
	if (code !== 0)
		throw new Error('Could not verify offline process inventory; migration refused.');
	if (output.trim() && output.trim() !== 'null')
		throw new Error('A Summon window or session process is still present; migration refused.');
}
