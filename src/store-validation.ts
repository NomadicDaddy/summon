import type { AgentRecord, Provider, SessionRef } from './store.ts';

import { validClaudeConfig } from './claude-config.ts';
import { validKiloOptions } from './kilo-config.ts';
import { validKiloVariant } from './kilo-variant.ts';
import { validMemberFields } from './member-role.ts';
import { validModelInfo } from './model-info.ts';

export function isAgentRecord(
	value: unknown,
	provider: (value: unknown) => value is Provider,
	sessionIdPattern: RegExp,
): value is AgentRecord {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.version === 3 &&
		validMemberFields(candidate) &&
		(candidate.hibernation === undefined || validHibernation(candidate.hibernation)) &&
		(candidate.modelInfo === undefined || validModelInfo(candidate.modelInfo)) &&
		typeof candidate.name === 'string' &&
		typeof candidate.expertise === 'string' &&
		(candidate.domain === undefined || typeof candidate.domain === 'string') &&
		(candidate.backup === undefined || typeof candidate.backup === 'string') &&
		typeof candidate.cwd === 'string' &&
		typeof candidate.createdAt === 'string' &&
		typeof candidate.updatedAt === 'string' &&
		provider(candidate.provider) &&
		validClaudeConfig(candidate.provider, candidate.claudeConfigDir) &&
		validKiloOptions(candidate.provider, candidate.model, candidate.lmStudioUrl) &&
		validKiloVariant(candidate.provider, candidate.model, candidate.variant) &&
		Array.isArray(candidate.sessions) &&
		candidate.sessions.every((session: unknown) => isSessionRef(session, sessionIdPattern))
	);
}

function validHibernation(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false;
	const state = value as Record<string, unknown>;
	return (
		typeof state.active === 'boolean' &&
		typeof state.revision === 'string' &&
		/^[a-f0-9-]{36}$/.test(state.revision) &&
		Number.isSafeInteger(state.changedAt)
	);
}

function isSessionRef(value: unknown, sessionIdPattern: RegExp): value is SessionRef {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === 'string' &&
		sessionIdPattern.test(candidate.id) &&
		validClaudeConfig('claude', candidate.claudeConfigDir) &&
		typeof candidate.createdAt === 'string' &&
		typeof candidate.lastUsedAt === 'string'
	);
}
