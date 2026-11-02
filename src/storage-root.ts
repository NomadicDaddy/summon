import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const defaultTeamDirectory = 'team-default';
export const standaloneBaseArgument = '--standalone-store';

/** The installation's team directories and maintenance command share this base. */
export function teamsBaseRoot(): string {
	return resolve(process.env.SUMMON_TEAMS_HOME || join(homedir(), '.summon'));
}

/** SUMMON_HOME is always a selected store, never an instruction to append another team. */
export function storageRoot(): string {
	return resolve(process.env.SUMMON_HOME || join(teamsBaseRoot(), defaultTeamDirectory));
}

export function sameStoragePath(left: string, right: string): boolean {
	const normalize = (path: string) =>
		process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
	return normalize(left) === normalize(right);
}

/** A standalone custom store must not gain an implicit base through a child environment. */
export function selectedTeamsBase(): string | undefined {
	const base = teamsBaseRoot();
	const root = storageRoot();
	return process.env.SUMMON_TEAMS_HOME ||
		(sameStoragePath(dirname(root), base) && basename(root).toLowerCase().startsWith('team-'))
		? base
		: undefined;
}

export function teamLabel(): string | undefined {
	const root = storageRoot();
	if (sameStoragePath(root, join(teamsBaseRoot(), defaultTeamDirectory))) return undefined;
	const directory = basename(root);
	return directory.toLowerCase().startsWith('team-')
		? directory.slice('team-'.length)
		: undefined;
}
