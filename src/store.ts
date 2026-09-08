import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';

export const providers = ['codex', 'claude'] as const;
export type Provider = (typeof providers)[number];

export interface SessionRef {
	id: string;
	createdAt: string;
	lastUsedAt: string;
}

export interface AgentRecord {
	version: 2;
	name: string;
	notes: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	provider: Provider;
	sessions: SessionRef[];
}

export function storageRoot(): string {
	return process.env.SUMMON_HOME ?? join(homedir(), '.agent');
}

export function slugFor(name: string): string {
	const slug = name.trim().toLowerCase();
	if (slug.length > 64) throw new Error('Names may not be longer than 64 characters.');
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) {
		throw new Error('Names may contain letters, numbers, dots, underscores, and dashes.');
	}
	return slug;
}

export function appendNote(record: AgentRecord, note: string): void {
	const notes = record.notes ? `${record.notes}\n${note}` : note;
	if (notes.length > 16_000) {
		throw new Error('Persistent notes may not be longer than 16,000 characters.');
	}
	record.notes = notes;
}

export function recordPath(slug: string): string {
	return join(storageRoot(), `${slug}.json`);
}

export function newRecord(name: string, cwd: string, provider: Provider): AgentRecord {
	const now = new Date().toISOString();
	return {
		version: 2,
		name,
		notes: '',
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
		if (!isAgentRecord(parsed)) {
			throw new Error(
				`Invalid agent record: ${recordPath(slug)}. Expected version 2 with a registered provider and a session list.`,
			);
		}
		return parsed;
	} catch (error: unknown) {
		if (isNodeError(error) && error.code === 'ENOENT') return undefined;
		throw error;
	}
}

export async function saveAgent(slug: string, record: AgentRecord): Promise<void> {
	const target = recordPath(slug);
	const temporary = `${target}.${process.pid}.tmp`;
	record.updatedAt = new Date().toISOString();
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	await writeFile(temporary, `${JSON.stringify(record, null, '\t')}\n`, { mode: 0o600 });
	try {
		await rename(temporary, target);
	} catch (error: unknown) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

export function latestSession(record: AgentRecord): SessionRef | undefined {
	return record.sessions.at(-1);
}

export function rememberSession(record: AgentRecord, id: string): void {
	const now = new Date().toISOString();
	const existing = record.sessions.find((session) => session.id === id);
	if (existing) {
		existing.lastUsedAt = now;
		record.sessions = [...record.sessions.filter((session) => session.id !== id), existing];
		return;
	}
	record.sessions.push({ id, createdAt: now, lastUsedAt: now });
}

export function forgetSession(record: AgentRecord, id: string): void {
	record.sessions = record.sessions.filter((session) => session.id !== id);
}

function isAgentRecord(value: unknown): value is AgentRecord {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	const sessions = candidate.sessions;
	return (
		candidate.version === 2 &&
		typeof candidate.name === 'string' &&
		typeof candidate.notes === 'string' &&
		typeof candidate.cwd === 'string' &&
		typeof candidate.createdAt === 'string' &&
		typeof candidate.updatedAt === 'string' &&
		isProvider(candidate.provider) &&
		Array.isArray(sessions) &&
		sessions.every(isSessionRef)
	);
}

export function isProvider(value: unknown): value is Provider {
	return value === 'codex' || value === 'claude';
}

function isSessionRef(value: unknown): value is SessionRef {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === 'string' &&
		typeof candidate.createdAt === 'string' &&
		typeof candidate.lastUsedAt === 'string'
	);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
