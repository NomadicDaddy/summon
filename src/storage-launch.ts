import { selectedTeamsBase, standaloneBaseArgument, storageRoot } from './storage-root.ts';

/** Carry the selection explicitly when an existing terminal has a stale environment. */
export function sessionStorageArguments(): string[] {
	return [
		'--storage-root',
		storageRoot(),
		'--teams-base',
		selectedTeamsBase() ?? standaloneBaseArgument,
	];
}

export function sessionStorageEnvironment(source: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = { ...source, SUMMON_HOME: storageRoot() };
	const base = selectedTeamsBase();
	if (base) env.SUMMON_TEAMS_HOME = base;
	else delete env.SUMMON_TEAMS_HOME;
	return env;
}
