import { resolve } from 'node:path';

import { assertStorageLayout } from './storage-layout.ts';
import {
	sameStoragePath,
	selectedTeamsBase,
	standaloneBaseArgument,
	storageRoot,
} from './storage-root.ts';
import { selectTeamStorage } from './team-storage.ts';

/** Select and check before read-only routing or any initializer can touch the store. */
export async function configureStorage(args: string[]): Promise<string[]> {
	if (args[0] === '__session' && args[2] === '--storage-root') {
		const root = args[3];
		if (!root) throw new Error('Missing internal storage root.');
		if (process.env.SUMMON_AGENT && !sameStoragePath(root, storageRoot()))
			throw new Error('A named member cannot select another storage root.');
		process.env.SUMMON_HOME = resolve(root);
		if (args[4] === '--teams-base') {
			const base = args[5];
			if (!base) throw new Error('Missing internal teams base.');
			const previousBase = selectedTeamsBase();
			if (
				process.env.SUMMON_AGENT &&
				(base !== standaloneBaseArgument
					? !previousBase || !sameStoragePath(base, previousBase)
					: previousBase !== undefined)
			)
				throw new Error('A named member cannot select another teams base.');
			if (base !== standaloneBaseArgument) process.env.SUMMON_TEAMS_HOME = resolve(base);
			else delete process.env.SUMMON_TEAMS_HOME;
			args = [...args.slice(0, 2), ...args.slice(6)];
		} else args = [...args.slice(0, 2), ...args.slice(4)];
	}
	if (args[0] === '--team') await selectTeamStorage(args.slice(1));
	const base = selectedTeamsBase();
	process.env.SUMMON_HOME = storageRoot();
	if (base) process.env.SUMMON_TEAMS_HOME = base;
	else delete process.env.SUMMON_TEAMS_HOME;
	await assertStorageLayout();
	return args;
}
