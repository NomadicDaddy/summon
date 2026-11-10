import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { AgentRecord } from './store.ts';

import { kiloTurn } from './kilo-turn-state.ts';
import { latestSession } from './store.ts';

export interface KiloProviderLimit {
	provider: 'zai-coding-plan';
	status: 429;
	code: '1310';
	observedAt: string;
}

const object = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

const sameDirectory = (left: string, right: string): boolean => {
	const normalize = (path: string): string =>
		process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
	return normalize(left) === normalize(right);
};

function completedAssistant(
	value: unknown,
	updatedAt: number,
	since: number,
): Record<string, unknown> | undefined {
	const message = object(value);
	const completed = object(message.time).completed;
	if (
		message.role !== 'assistant' ||
		!Number.isSafeInteger(updatedAt) ||
		updatedAt < since ||
		updatedAt > Date.now() + 60_000 ||
		typeof completed !== 'number' ||
		!Number.isSafeInteger(completed) ||
		completed < since ||
		completed > Date.now() + 60_000
	)
		return undefined;
	return message;
}

/** Only a completed assistant result can establish a provider-limit observation. */
export function classifyKiloProviderLimit(
	value: unknown,
	updatedAt: number,
	since: number,
): KiloProviderLimit | undefined {
	const message = completedAssistant(value, updatedAt, since);
	if (!message) return undefined;
	const error = object(message.error);
	const data = object(error.data);
	if (
		message.providerID !== 'zai-coding-plan' ||
		error.name !== 'APIError' ||
		data.statusCode !== 429 ||
		typeof data.responseBody !== 'string' ||
		data.responseBody.length > 8192
	)
		return undefined;
	let body: unknown;
	try {
		body = JSON.parse(data.responseBody) as unknown;
	} catch {
		return undefined;
	}
	if (object(object(body).error).code !== '1310') return undefined;
	return {
		provider: 'zai-coding-plan',
		status: 429,
		code: '1310',
		observedAt: new Date(object(message.time).completed as number).toISOString(),
	};
}

/** Read the exact registered session; no raw message or provider error leaves this module. */
export function readKiloProviderLimit(
	directory: string,
	sessionId: string,
	since: number,
	path = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'kilo', 'kilo.db'),
): KiloProviderLimit | undefined {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const session = object(
			db.prepare('SELECT directory FROM session WHERE id = ?').get(sessionId),
		);
		if (typeof session.directory !== 'string' || !sameDirectory(session.directory, directory))
			return undefined;
		const rows = db
			.prepare(
				"SELECT data, time_updated FROM message WHERE session_id = ? AND time_updated >= ? AND json_valid(data) AND json_extract(data, '$.role') = 'assistant' AND json_type(data, '$.time.completed') IS NOT NULL ORDER BY CAST(json_extract(data, '$.time.completed') AS INTEGER) DESC, time_updated DESC LIMIT 257",
			)
			.all(sessionId, since);
		for (const raw of rows.slice(0, 256)) {
			const row = object(raw);
			if (typeof row.data !== 'string' || row.data.length > 65536)
				throw new Error('Kilo provider observation could not be bounded.');
			const value = JSON.parse(row.data) as unknown;
			const updatedAt = Number(row.time_updated);
			const message = completedAssistant(value, updatedAt, since);
			if (!message) continue;
			const limit = classifyKiloProviderLimit(message, updatedAt, since);
			if (limit) return limit;
			if (
				message.error === undefined &&
				(message.finish === 'stop' ||
					message.finish === 'tool-calls' ||
					message.finish === 'length')
			)
				return undefined;
		}
		if (rows.length > 256)
			throw new Error('Kilo provider observation exceeded its scan bound.');
		return undefined;
	} finally {
		db.close();
	}
}

const cache = new Map<string, { at: number; value: KiloProviderLimit | undefined }>();

/** The current launch's bound Kilo thread, with a short cache for the two-second roster poll. */
export async function currentKiloProviderLimit(
	name: string,
	nonce: string,
	since: string,
	record: AgentRecord,
): Promise<KiloProviderLimit | undefined> {
	const state = await kiloTurn(name, nonce);
	const session = latestSession(record);
	if (!state || !session || state.thread !== session.id) return undefined;
	const started = Date.parse(since);
	if (!Number.isSafeInteger(started)) return undefined;
	const key = `${name}:${nonce}:${session.id}`;
	const prior = cache.get(key);
	if (prior && Date.now() - prior.at < 15_000) return prior.value;
	const value = readKiloProviderLimit(record.cwd, session.id, started);
	if (cache.size > 64) cache.clear();
	cache.set(key, { at: Date.now(), value });
	return value;
}
