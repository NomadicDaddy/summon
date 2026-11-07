import { homedir } from 'node:os';

import { runtimeFaultText } from './runtime-fault-model.ts';

export const DIAGNOSTIC_REDACTIONS = [
	'message bodies and work-card contents',
	'credentials, tokens and provider account identifiers',
	'private paths and file contents',
	'peer mailbox and runtime details',
	'home directory replaced by ~',
] as const;

/** A reason is useful for support, but arbitrary error payloads are never copied verbatim. */
export function diagnosticReason(value: unknown): string {
	if (typeof value !== 'string') return 'Unavailable; no safe error detail was supplied.';
	const home = homedir();
	const withoutHome = home
		? value.replaceAll(home, '~').replaceAll(home.replaceAll('\\', '/'), '~')
		: value;
	return runtimeFaultText(withoutHome)
		.replace(/~[\\/]\.summon[\\/][^\s"'<>]+/gi, '[private path omitted]')
		.replace(/\b[a-z]:[\\/][^\s"'<>]+/gi, '[path omitted]')
		.replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, '[account omitted]')
		.replace(/\b(?:acct|account|org|user)[_-][a-z0-9_-]{6,}\b/gi, '[account omitted]')
		.replace(/\b(?:sk|gh[pousr]|github_pat)[-_][a-z0-9_-]{8,}\b/gi, '[token omitted]');
}

export function diagnosticError(error: unknown): string {
	return diagnosticReason(error instanceof Error ? error.message : error);
}
