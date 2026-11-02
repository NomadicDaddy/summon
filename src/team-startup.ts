import { join } from 'node:path';

import { atomicWrite, optionalText } from './mail-files.ts';
import { storageRoot } from './store.ts';

export function teamWindowRuntime(...parts: string[]): string {
	return join(storageRoot(), 'runtime', 'team-window', ...parts);
}

export async function recordTeamStartup(startedAt: string): Promise<void> {
	await atomicWrite(teamWindowRuntime('started-at.txt'), startedAt);
}

/** Last window launch, not a liveness claim; retained after the window closes. */
export async function readTeamStartup(): Promise<string | null> {
	const value = await optionalText(teamWindowRuntime('started-at.txt'));
	return value && Number.isFinite(Date.parse(value)) ? value : null;
}
