import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { missing, optionalText } from './mail-files.ts';
import { parseOwner, processAlive } from './process-owner.ts';

export async function processStart(pid: number): Promise<number | 'absent' | undefined> {
	try {
		// CIM exposes creation time even when Get-Process cannot open a service's StartTime.
		const child = Bun.spawn({
			cmd: [
				'pwsh',
				'-NoProfile',
				'-NonInteractive',
				'-Command',
				`$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; if ($null -eq $p) { $control = Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop; if ($null -eq $control -or $control.ProcessId -ne $PID) { throw 'Process lookup control failed' }; 'absent' } elseif ($null -ne $p.CreationDate) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }`,
			],
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
			signal: AbortSignal.timeout(5000),
		});
		const [output, , code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0) return undefined;
		if (output.trim() === 'absent') return 'absent';
		const started = Number(output.trim());
		return Number.isSafeInteger(started) && started > 0 && started <= Date.now()
			? started
			: undefined;
	} catch {
		return undefined;
	}
}

/** A PID alone is not ownership: Windows may reuse it after a retained receiver exits. */
export function offlineRuntimeCheck(): (root: string) => Promise<void> {
	const starts = new Map<number, Promise<number | 'absent' | undefined>>();
	async function active(pid: number, writtenAt: number): Promise<boolean> {
		if (!Number.isSafeInteger(pid) || pid <= 0) return true;
		if (!processAlive(pid)) return false;
		let start = starts.get(pid);
		if (!start) {
			start = processStart(pid);
			starts.set(pid, start);
		}
		const started = await start;
		// Bun can report EPERM for a nonexistent Windows PID. A controlled CIM lookup can clear it.
		if (started === 'absent') return false;
		return started === undefined || started <= writtenAt;
	}
	async function metadataTime(path: string): Promise<number> {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink())
			throw new Error(`Linked or invalid runtime metadata; migration refused: ${path}`);
		return info.mtimeMs;
	}
	return async (root) => {
		for (const entry of await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
			if (missing(error)) return [];
			throw error;
		})) {
			const path = join(root, entry.name);
			if (entry.isSymbolicLink()) throw new Error('Linked runtime entry; migration refused.');
			if (
				entry.isDirectory() &&
				(entry.name === 'receiver' ||
					entry.name === 'session.lock' ||
					entry.name.startsWith('session-pending-') ||
					entry.name.startsWith('receiver-pending-'))
			) {
				const ownerPath = join(path, 'owner.json');
				const raw = await optionalText(ownerPath);
				const owner = raw ? parseOwner(raw) : undefined;
				if (!owner)
					throw new Error(
						`Active or unverifiable runtime owner; migration refused: ${ownerPath}`,
					);
				const writtenAt = await metadataTime(ownerPath);
				for (const pid of [
					owner.pid,
					...(owner.childPid === undefined ? [] : [owner.childPid]),
				]) {
					if (await active(pid, writtenAt))
						throw new Error(
							`Active or unverifiable runtime owner; migration refused: ${ownerPath} (PID ${pid})`,
						);
				}
			} else if (
				entry.isFile() &&
				entry.name.endsWith('.json') &&
				!entry.name.startsWith('checkpoint')
			) {
				const writtenAt = await metadataTime(path);
				const value: unknown = JSON.parse((await optionalText(path)) ?? 'null');
				if (value && typeof value === 'object' && 'pid' in value) {
					const pid = typeof value.pid === 'number' ? value.pid : Number.NaN;
					if (await active(pid, writtenAt))
						throw new Error(
							`Active or unverifiable receiver; migration refused: ${path} (PID ${Number.isSafeInteger(pid) ? pid : 'invalid'})`,
						);
				}
			}
		}
	};
}
