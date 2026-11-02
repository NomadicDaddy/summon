import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { missing } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import {
	defaultTeamDirectory,
	sameStoragePath,
	storageRoot,
	teamsBaseRoot,
} from './storage-root.ts';

/** Select before initialization: opening a test team must not rewrite the default registry. */
export async function selectTeamStorage(args: string[]): Promise<void> {
	operatorOnly();
	if (args.length > 1) throw new Error('Usage: summon --team [team-name]');
	const base = teamsBaseRoot();
	if (args.length === 0) return;
	if (
		!process.env.SUMMON_TEAMS_HOME &&
		process.env.SUMMON_HOME &&
		!sameStoragePath(storageRoot(), join(base, defaultTeamDirectory))
	)
		throw new Error('Set SUMMON_TEAMS_HOME explicitly when selecting from a custom store.');
	const name = args[0]?.toLowerCase() ?? '';
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name))
		throw new Error(
			'Team names require 1–64 letters, digits, underscores or hyphens, starting with a letter or digit.',
		);
	const directory = `team-${name}`;
	const target = join(base, directory);
	const entry = await lstat(target).catch((error: unknown) => {
		if (missing(error)) return undefined;
		throw error;
	});
	if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
		throw new Error('A named team must be a real directory, not a file or directory link.');
	process.env.SUMMON_TEAMS_HOME = base;
	process.env.SUMMON_HOME = target;
}
