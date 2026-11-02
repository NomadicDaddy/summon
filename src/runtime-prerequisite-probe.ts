import { execFile } from 'node:child_process';

import type { RuntimePrerequisiteStatus } from './runtime-prerequisites.ts';

import { resolveExecutable } from './executable.ts';
import { runtimePrerequisites, runtimeVersionStatus } from './runtime-prerequisites.ts';

export async function probeRuntimePrerequisites(): Promise<RuntimePrerequisiteStatus[]> {
	return Promise.all(
		runtimePrerequisites.map(async ({ id }): Promise<RuntimePrerequisiteStatus> => {
			// Only native runtime executables, never shell wrappers or Windows PowerShell 5.
			const executable = resolveExecutable(process.platform === 'win32' ? `${id}.exe` : id);
			if (!executable) return { id, status: 'missing', detail: 'Not found on PATH' };
			return new Promise((resolve) => {
				execFile(
					executable,
					['--version'],
					{ windowsHide: true, timeout: 5000, maxBuffer: 16384 },
					(error, stdout, stderr) => {
						resolve(
							error
								? {
										id,
										status: 'unavailable',
										detail: 'Version check failed or timed out',
									}
								: runtimeVersionStatus(id, stdout || stderr),
						);
					},
				);
			});
		}),
	);
}
