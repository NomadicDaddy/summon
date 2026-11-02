import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ModelInfo } from './model-info.ts';

import { claudeConfigDirectory, claudeSessionMatches } from './claude-config.ts';
import { authorizeNewTeammate } from './claude-delivery.ts';
import { atomicWrite, locked, missing, optionalText, type WriteProgress } from './mail-files.ts';
import { effectiveMember } from './member-role.ts';
import { assertNotesLimit } from './notes-limit.ts';
import { writeMemberIdentity } from './operator-member-identity.ts';
import { storageRoot } from './storage-root.ts';
import { isAgentRecord } from './store-validation.ts';

export { storageRoot, teamLabel } from './storage-root.ts';

export const providers = ['codex', 'claude', 'grok', 'kilo'] as const;
export type Provider = (typeof providers)[number];
export const sessionIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;

export interface SessionRef {
	claudeConfigDir?: string;
	id: string;
	createdAt: string;
	lastUsedAt: string;
}

export interface AgentRecord {
	memberType?: 'teammate' | 'pm';
	displayName?: string;
	canStopResting?: boolean;
	version: 3;
	/** Operator-owned state; ordinary profile/session saves must preserve it. */
	hibernation?: { active: boolean; revision: string; changedAt: number };
	name: string;
	/**
	 * Standing expertise; current decisions and handoff pointers belong in the adjacent notes.
	 */
	expertise: string;
	/**
	 * The areas or projects this name is the primary for, in plain prose.
	 * Optional, and absent on every record written before it existed. A name without one still
	 * works; it simply claims nothing, so no other session is told to hand work to it.
	 */
	domain?: string;
	/**
	 * The registered name that covers this one's domain: the second pair of hands, and the
	 * one the user is most likely to summon when this name is unavailable.
	 * Display name, not slug; registrations cannot be renamed. Optional; absence exposes a coverage gap.
	 * Records cover, not authority to act, take over work or start sessions. The user decides.
	 */
	backup?: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	provider: Provider;
	claudeConfigDir?: string;
	model?: string;
	/** Kilo only: registered reasoning variant for each launch's startup turn, if the model lists it. */
	variant?: string;
	modelInfo?: ModelInfo;
	lmStudioUrl?: string;
	sessions: SessionRef[];
}

/** One other registered name, as a session is told about it. */
export interface AgentDomain {
	slug: string;
	name: string;
	memberType?: 'teammate' | 'pm';
	domain: string;
	/** Whoever covers that name's domain, when anybody does. */
	backup?: string;
}

export function slugFor(name: string): string {
	const slug = name.trim().toLowerCase();
	// operator names the human at the console (room sender, rest-stop actor, approvals).
	if (slug === 'operator')
		throw new Error(
			'The name operator is reserved for the human operator; choose another name.',
		);
	if (['agents', 'team-window', 'list', 'all'].includes(slug))
		throw new Error(`The name ${slug} is reserved.`);
	if (slug.length > 64) throw new Error('Names may not be longer than 64 characters.');
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) {
		throw new Error('Names may contain letters, numbers, dots, underscores, and dashes.');
	}
	return slug;
}

export function recordPath(slug: string): string {
	return join(storageRoot(), `${slug}.json`);
}

/** Enumerate regular records with canonical names; callers decide how to handle bad contents. */
export async function listAgentSlugs(): Promise<string[]> {
	const slugs: string[] = [];
	for (const entry of await readdir(storageRoot(), { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
		const stem = entry.name.slice(0, -5);
		try {
			if (slugFor(stem) === stem) slugs.push(stem);
		} catch {
			// Other registry files are not agent records.
		}
	}
	return slugs.sort((left, right) => left.localeCompare(right));
}

/** Markdown beside the record, holding the notes that accumulate as sessions run. */
export function notesPath(slug: string): string {
	return join(storageRoot(), `${slug}.md`);
}

/** Append to a teammate's durable notes under the shared notes lock. */
export async function appendNote(slug: string, note: string): Promise<void> {
	const target = notesPath(slug);
	await locked(`${target}.lock`, async () => {
		const existing = (await optionalText(target)) ?? '';
		const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
		const updated = `${existing}${separator}${note.trim()}\n`;
		assertNotesLimit(updated);
		await atomicWrite(target, updated);
	});
}

/** Startup includes the complete bounded active notes; oversized files require owner compaction. */
export async function readNotes(slug: string): Promise<string> {
	const text = await readFile(notesPath(slug), 'utf8').catch(() => '');
	assertNotesLimit(text);
	return text;
}

export function newRecord(name: string, cwd: string, provider: Provider): AgentRecord {
	const now = new Date().toISOString();
	return {
		version: 3,
		name,
		expertise: '',
		cwd,
		createdAt: now,
		updatedAt: now,
		provider,
		sessions: [],
	};
}

export async function loadAgent(slug: string): Promise<AgentRecord | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(recordPath(slug), 'utf8'));
		if (!isAgentRecord(parsed, isProvider, sessionIdPattern)) {
			throw new Error(
				`Invalid agent record: ${recordPath(slug)}. Expected version 3 with an expertise string, a registered provider, and a session list. To convert a version 2 record, set version to 3, rename its notes field to expertise, and move anything that reads as running notes into ${notesPath(slug)}.`,
			);
		}
		return effectiveMember(parsed);
	} catch (error: unknown) {
		if (missing(error)) return undefined;
		throw error;
	}
}

export async function saveAgent(
	slug: string,
	record: AgentRecord,
	createOnly = false,
): Promise<void> {
	await locked(`${recordPath(slug)}.write-lock`, async () => {
		const current = await loadAgent(slug);
		if (!current) await authorizeNewTeammate();
		if (createOnly && current) throw new Error('That teammate already exists.');
		if (current?.hibernation) record.hibernation = current.hibernation;
		if (current?.modelInfo) record.modelInfo = current.modelInfo;
		if (process.env.SUMMON_AGENT && current) {
			if (current.claudeConfigDir) record.claudeConfigDir = current.claudeConfigDir;
			else delete record.claudeConfigDir;
			record.memberType = current.memberType ?? 'teammate';
			record.canStopResting = current.canStopResting ?? false;
		}
		await writeAgent(slug, record);
	});
}

/**
 * Reread, change and atomically rewrite one record under its write lock.
 * @param update May be async when work must happen under the same lock before the write, such as
 * the registration-text audit entry; a throw leaves the record unwritten.
 * @param progress Filled by the write itself, so a caller can tell a completed write from a failed
 * one even when releasing the lock afterwards throws.
 */
export async function updateAgentRecord(
	slug: string,
	update: (record: AgentRecord) => Promise<void> | void,
	progress?: WriteProgress,
): Promise<void> {
	await locked(`${recordPath(slug)}.write-lock`, async () => {
		const record = await loadAgent(slug);
		if (!record) throw new Error(`No stored agent named ${slug}.`);
		const memberType = record.memberType ?? 'teammate';
		const canStopResting = record.canStopResting ?? false;
		const claudeConfigDir = record.claudeConfigDir;
		await update(record);
		if (process.env.SUMMON_AGENT) {
			if (claudeConfigDir) record.claudeConfigDir = claudeConfigDir;
			else delete record.claudeConfigDir;
			record.memberType = memberType;
			record.canStopResting = canStopResting;
		}
		await writeAgent(slug, record, progress);
	});
}

async function writeAgent(
	slug: string,
	record: AgentRecord,
	progress?: WriteProgress,
): Promise<void> {
	if (!isAgentRecord(record, isProvider, sessionIdPattern)) {
		if (progress) progress.failed = true;
		throw new Error('Refusing to save an invalid agent record.');
	}
	record.updatedAt = new Date().toISOString();
	await writeMemberIdentity(slug, record, progress);
}

/**
 * Every other registered name that claims a domain, so a session can say who owns the work it has
 * just wandered into. A record that claims nothing is left out rather than listed as unowned, and
 * an unreadable or invalid record is skipped: this is context for a prompt, not a gate.
 * @param exceptSlug The name being summoned, which does not belong in its own roster.
 * @returns The other names and their domains, ordered by name.
 */
export async function listAgentDomains(exceptSlug: string): Promise<AgentDomain[]> {
	let entries: string[];
	try {
		entries = await listAgentSlugs();
	} catch {
		return [];
	}
	const domains: AgentDomain[] = [];
	for (const slug of entries) {
		if (slug === exceptSlug) continue;
		const record = await loadAgent(slug).catch(() => undefined);
		const domain = record?.domain?.trim();
		if (!record || !domain) continue;
		const backup = record.backup?.trim();
		domains.push({
			domain,
			name: record.memberType === 'pm' ? record.displayName || record.name : record.name,
			slug,
			memberType: record.memberType ?? 'teammate',
			...(backup ? { backup } : {}),
		});
	}
	return domains.sort((left, right) => left.name.localeCompare(right.name));
}

export function latestSession(record: AgentRecord): SessionRef | undefined {
	return record.provider === 'claude'
		? record.sessions.findLast((session) => claudeSessionMatches(record, session))
		: record.sessions.at(-1);
}

export function rememberSession(record: AgentRecord, id: string): void {
	const now = new Date().toISOString();
	const existing = record.sessions.find(
		(session) =>
			session.id === id &&
			(record.provider !== 'claude' || claudeSessionMatches(record, session)),
	);
	if (existing) {
		if (record.provider === 'claude') existing.claudeConfigDir = claudeConfigDirectory(record);
		existing.lastUsedAt = now;
		record.sessions = [...record.sessions.filter((session) => session !== existing), existing];
		return;
	}
	record.sessions.push({
		id,
		createdAt: now,
		lastUsedAt: now,
		...(record.provider === 'claude' ? { claudeConfigDir: claudeConfigDirectory(record) } : {}),
	});
}

export function forgetSession(record: AgentRecord, id: string): void {
	record.sessions = record.sessions.filter(
		(session) =>
			session.id !== id ||
			(record.provider === 'claude' && !claudeSessionMatches(record, session)),
	);
}

export function isProvider(value: unknown): value is Provider {
	return value === 'codex' || value === 'claude' || value === 'grok' || value === 'kilo';
}
