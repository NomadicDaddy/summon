import { appendFile, lstat, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { locked, missing, optionalText } from './mail-files.ts';
import { textHash } from './profile-text.ts';
import { type AgentRecord, loadAgent, slugFor, storageRoot } from './store.ts';

/** Old and new sha256 of one changed field; the texts themselves stay in the record. */
export interface TextChange {
	old: string;
	new: string;
}
export interface IntentEntry {
	kind: 'intent';
	id: string;
	at: string;
	actor: string;
	target: string;
	/** The operator decision reference exactly as given, or null for the operator's own edit. */
	decision: string | null;
	changes: { expertise?: TextChange; domain?: TextChange };
}

/**
 * Intent and commit. `intent` is appended before the record write, `applied` after it lands, and
 * `not-applied` when the write failed. An intent alone never means applied: a crash, or a failed
 * marker, between the steps leaves it to reconcileRegistrationAudit, which decides by hash.
 */
export type AuditEntry =
	| IntentEntry
	| { kind: 'applied'; id: string; at: string }
	| { kind: 'not-applied'; id: string; at: string; reason: string };

export type AuditStatus = 'applied' | 'not-applied' | 'applied-unmarked' | 'unresolved';

export const registrationAuditPath = (): string =>
	join(storageRoot(), 'audit', 'registration-text.jsonl');

/**
 * Append one entry. Opened in append mode only: nothing here rewrites or truncates the log.
 * @param entry The entry, written as one JSON line.
 */
export async function appendRegistrationAudit(entry: AuditEntry): Promise<void> {
	const path = registrationAuditPath();
	await mkdir(dirname(path), { recursive: true });
	await locked(`${path}.lock`, async () => {
		const info = await lstat(path).catch((error: unknown) => {
			if (missing(error)) return undefined;
			throw error;
		});
		if (info && (!info.isFile() || info.isSymbolicLink()))
			throw new Error('Registration audit log is not a regular file.');
		await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
	});
}

/**
 * Every parseable line, plus a count of lines that are not, such as one torn by a crash mid-append.
 * @returns The entries in file order.
 */
export async function readRegistrationAudit(): Promise<{
	entries: AuditEntry[];
	malformed: number;
}> {
	const entries: AuditEntry[] = [];
	let malformed = 0;
	for (const line of ((await optionalText(registrationAuditPath())) ?? '').split('\n')) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line) as Partial<AuditEntry>;
			if (
				typeof value.id !== 'string' ||
				!['intent', 'applied', 'not-applied'].includes(value.kind ?? '')
			)
				throw new Error('Unknown audit entry.');
			entries.push(value as AuditEntry);
		} catch {
			malformed++;
		}
	}
	return { entries, malformed };
}

/**
 * Classify each intent: `applied` or `not-applied` from its outcome line; with none,
 * `applied-unmarked` when the target's current text has every new hash the intent recorded, and
 * otherwise `unresolved`. An intent with no outcome is never treated as applied on its own.
 * @param entries The log, in order.
 * @param current The target's current text, or undefined when it no longer exists.
 * @returns Each intent with its status.
 */
export function reconcileRegistrationAudit(
	entries: readonly AuditEntry[],
	current: (target: string) => { expertise: string; domain?: string } | undefined,
): { intent: IntentEntry; status: AuditStatus }[] {
	const outcomes = new Map<string, 'applied' | 'not-applied'>();
	for (const entry of entries) if (entry.kind !== 'intent') outcomes.set(entry.id, entry.kind);
	return entries.flatMap((entry): { intent: IntentEntry; status: AuditStatus }[] => {
		if (entry.kind !== 'intent') return [];
		const outcome = outcomes.get(entry.id);
		if (outcome) return [{ intent: entry, status: outcome }];
		const text = current(entry.target);
		const changed = Object.entries(entry.changes);
		const matches =
			text !== undefined &&
			changed.length > 0 &&
			changed.every(
				([field, change]) =>
					textHash(field === 'domain' ? (text.domain ?? '') : text.expertise) ===
					change.new,
			);
		return [{ intent: entry, status: matches ? 'applied-unmarked' : 'unresolved' }];
	});
}

/**
 * `summon --registration audit [name]`: each intent with its reconciled status, oldest first.
 * Malformed lines are counted rather than hidden.
 * @param name Limit the listing to one target.
 */
export async function printRegistrationAudit(name?: string): Promise<void> {
	const only = name === undefined ? undefined : slugFor(name);
	const { entries, malformed } = await readRegistrationAudit();
	const current = new Map<string, AgentRecord | undefined>();
	for (const entry of entries)
		if (entry.kind === 'intent' && !current.has(entry.target))
			current.set(entry.target, await loadAgent(entry.target).catch(() => undefined));
	const rows = reconcileRegistrationAudit(entries, (target) => current.get(target))
		.filter(({ intent }) => only === undefined || intent.target === only)
		.map(({ intent, status }) => ({ ...intent, status }));
	console.log(JSON.stringify({ entries: rows, malformed }));
}
