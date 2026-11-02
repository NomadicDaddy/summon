import { resolve } from 'node:path';

import { prepareStorageLayout } from '../storage-layout.ts';
import { standaloneBaseArgument } from '../storage-root.ts';

/** Refuse before Electron creates userData, including when an old launcher supplies old args. */
export async function prepareTeamWindowStorage(args: string[]): Promise<[string, string, string]> {
	const [root, bun, cli, base, receipt] = args;
	if (args.length !== 5 || !root || !bun || !cli || !base || !receipt || process.env.SUMMON_AGENT)
		throw new Error('Open the team window from your own terminal with summon --team.');
	process.env.SUMMON_HOME = resolve(root);
	if (base !== standaloneBaseArgument) process.env.SUMMON_TEAMS_HOME = resolve(base);
	else delete process.env.SUMMON_TEAMS_HOME;
	await prepareStorageLayout();
	return [bun, cli, receipt];
}
