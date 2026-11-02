import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { AgentRecord, SessionRef } from './store.ts';

/** Configuration directory identifies a Claude login; no credential files are inspected. */
export function claudeConfigDirectory(record: Pick<AgentRecord, 'claudeConfigDir'>): string {
	return resolve(
		record.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
	);
}

export function directoryKey(path: string): string {
	const absolute = resolve(path);
	return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export function validClaudeConfig(provider: unknown, directory: unknown): boolean {
	return (
		directory === undefined ||
		(provider === 'claude' &&
			typeof directory === 'string' &&
			directory.length > 0 &&
			directory.length <= 2000 &&
			!directory.includes('\0') &&
			isAbsolute(directory))
	);
}

export async function selectedClaudeConfig(
	provider: string,
	value: unknown,
): Promise<string | undefined> {
	if (value === undefined || value === '') return undefined;
	if (!validClaudeConfig(provider, value))
		throw new Error('Claude account directory must be an absolute path and requires Claude.');
	const path = value as string;
	if (!(await stat(path).catch(() => undefined))?.isDirectory())
		throw new Error(
			'Choose an existing Claude account directory. Sign in to it manually first.',
		);
	return realpath(path);
}

export function claudeSessionMatches(record: AgentRecord, session: SessionRef): boolean {
	return session.claudeConfigDir
		? directoryKey(session.claudeConfigDir) === directoryKey(claudeConfigDirectory(record))
		: record.claudeConfigDir === undefined;
}

/** Preserve each account's conversations when the operator selects another login. */
export function applyClaudeConfig(record: AgentRecord, directory: string | undefined): void {
	const oldDirectory = claudeConfigDirectory(record);
	const newDirectory = claudeConfigDirectory({
		...(directory ? { claudeConfigDir: directory } : {}),
	});
	if (record.provider === 'claude') {
		for (const session of record.sessions) session.claudeConfigDir ??= oldDirectory;
		if (directoryKey(oldDirectory) !== directoryKey(newDirectory)) delete record.modelInfo;
	}
	if (directory) record.claudeConfigDir = directory;
	else delete record.claudeConfigDir;
}

export function claudeEnvironment(record: AgentRecord): NodeJS.ProcessEnv {
	return record.provider === 'claude'
		? { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDirectory(record) }
		: process.env;
}
