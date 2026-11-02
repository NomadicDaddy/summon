import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ModelInfo } from './model-info.ts';
import type { AgentRecord } from './store.ts';

import { claudeConfigDirectory, directoryKey } from './claude-config.ts';
import { readClaudeModel } from './claude-model-observation.ts';
import { codexContextCapacity } from './codex-context-capacity.ts';
import { readKiloCapacity } from './kilo-model-observation.ts';
import { recordModelHistory } from './model-history.ts';
import { metadataText } from './model-info.ts';
import { latestSession, sessionIdPattern, storageRoot, updateAgentRecord } from './store.ts';

const object = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const paths = new Map<string, string>();
const checked = new Map<string, number>();
const pending = new Map<string, Promise<ModelInfo | undefined>>();
const limit = 4 * 1024 * 1024;

/** Extract only model settings, never conversation text, tools, or reasoning content. */
export function modelEvent(
	provider: string,
	value: unknown,
	id: string,
): Partial<ModelInfo> | undefined {
	const event = object(value);
	if (provider === 'codex' && event.type === 'turn_context') {
		const payload = object(event.payload);
		const model = metadataText(payload.model);
		const reasoning = metadataText(payload.effort);
		return model ? { model, ...(reasoning ? { reasoning } : {}) } : undefined;
	}
	if (
		provider === 'claude' &&
		event.type === 'assistant' &&
		(event.sessionId === id || event.session_id === id) &&
		event.isSidechain !== true
	) {
		const model = metadataText(object(event.message).model);
		const reasoning = metadataText(event.effort);
		return model && model !== '<synthetic>'
			? { model, ...(reasoning ? { reasoning } : {}) }
			: undefined;
	}
	return undefined;
}

async function codexPath(root: string, id: string, depth = 0): Promise<string | undefined> {
	if (depth > 4) return undefined;
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isFile() && entry.name.endsWith(`-${id}.jsonl`)) return path;
		if (entry.isDirectory()) {
			const found = await codexPath(path, id, depth + 1);
			if (found) return found;
		}
	}
	return undefined;
}

async function claudePath(root: string, cwd: string, id: string): Promise<string | undefined> {
	const expected = join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
	const key = `claude:${root}:${id}`;
	try {
		if ((await stat(paths.get(key) ?? expected)).isFile()) return paths.get(key) ?? expected;
	} catch {
		paths.delete(key);
	}
	// Resumed sessions can retain their original Claude project directory after the agent's
	// registered working directory changes. Inspect only files named for this exact session.
	let newest: { path: string; modified: number } | undefined;
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const candidate = join(root, entry.name, `${id}.jsonl`);
		try {
			const status = await stat(candidate);
			if (status.isFile() && (!newest || status.mtimeMs > newest.modified))
				newest = { path: candidate, modified: status.mtimeMs };
		} catch {
			// Other project directories normally do not contain this session.
		}
	}
	if (newest) paths.set(key, newest.path);
	return newest?.path;
}

async function tail(path: string): Promise<{ text: string; observedAt: string }> {
	const file = await open(path, 'r');
	try {
		const status = await file.stat();
		const start = Math.max(0, status.size - limit);
		const buffer = Buffer.alloc(status.size - start);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
		let text = buffer.subarray(0, bytesRead).toString('utf8');
		if (start) text = text.slice(text.indexOf('\n') + 1);
		return { text, observedAt: status.mtime.toISOString() };
	} finally {
		await file.close();
	}
}

export async function readProviderModel(
	record: AgentRecord,
	home = homedir(),
	slug?: string,
): Promise<ModelInfo | undefined> {
	const id = latestSession(record)?.id;
	if (!id || !sessionIdPattern.test(id)) return undefined;
	const native =
		record.provider === 'claude' && slug
			? await readClaudeModel(slug, id).catch(() => undefined)
			: undefined;
	let model: string | undefined;
	let reasoning: string | undefined;
	let contextWindow: number | undefined;
	let observedAt: string;
	if (record.provider === 'kilo') {
		const db = new DatabaseSync(
			join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'kilo', 'kilo.db'),
			{ readOnly: true },
		);
		try {
			const row = object(
				db
					.prepare('SELECT directory, model, time_updated FROM session WHERE id = ?')
					.get(id),
			);
			if (!row.model) return undefined;
			const normalize = (path: string): string =>
				process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
			if (
				typeof row.directory !== 'string' ||
				normalize(row.directory) !== normalize(record.cwd)
			)
				return undefined;
			const settings = object(
				JSON.parse(typeof row.model === 'string' ? row.model : '{}') as unknown,
			);
			model = metadataText(settings.id);
			const provider = metadataText(settings.providerID);
			if (model && provider) model = metadataText(`${provider}/${model}`);
			if (slug && model)
				contextWindow = await readKiloCapacity(slug, id, model).catch(() => undefined);
			reasoning = metadataText(settings.variant);
			observedAt = new Date(Number(row.time_updated)).toISOString();
		} finally {
			db.close();
		}
	} else if (record.provider === 'grok') {
		const path = join(
			home,
			'.grok',
			'sessions',
			encodeURIComponent(record.cwd),
			id,
			'summary.json',
		);
		const status = await stat(path);
		if (status.size > limit) return undefined;
		const summary = object(JSON.parse(await readFile(path, 'utf8')) as unknown);
		model = metadataText(summary.current_model_id);
		reasoning = metadataText(summary.reasoning_effort);
		if (
			typeof summary.context_window === 'number' &&
			Number.isSafeInteger(summary.context_window) &&
			summary.context_window > 0
		)
			contextWindow = summary.context_window;
		observedAt = status.mtime.toISOString();
	} else {
		let path: string | undefined;
		if (record.provider === 'claude') {
			try {
				path = await claudePath(
					join(claudeConfigDirectory(record), 'projects'),
					record.cwd,
					id,
				);
			} catch (error: unknown) {
				if (native) return native;
				throw error;
			}
		} else {
			const root = join(process.env.CODEX_HOME ?? join(home, '.codex'), 'sessions');
			const key = `${root}:${id}`;
			path = paths.get(key) ?? (await codexPath(root, id));
			if (path) paths.set(key, path);
		}
		if (!path) return native;
		const content = await tail(path);
		observedAt = content.observedAt;
		const lines = content.text.split('\n');
		for (const line of [...lines].reverse()) {
			try {
				const event: unknown = JSON.parse(line);
				const info = modelEvent(record.provider, event, id);
				if (info?.model) {
					model = info.model;
					reasoning = info.reasoning;
					if (record.provider === 'codex')
						contextWindow = codexContextCapacity(lines, event, id);
					break;
				}
			} catch {
				/* Partial last writes and oversized lines are not observations. */
			}
		}
	}
	if (
		native &&
		(native.model === model || Date.parse(native.observedAt) >= Date.parse(observedAt))
	)
		return { ...native, ...(native.model === model && reasoning ? { reasoning } : {}) };
	return model
		? {
				provider: record.provider,
				sessionId: id,
				model,
				...(reasoning ? { reasoning } : {}),
				...(contextWindow === undefined ? {} : { contextWindow }),
				observedAt,
			}
		: undefined;
}

/** Throttled read-only provider inspection; cache writes merge under the profile lock. */
export async function refreshModelInfo(
	slug: string,
	record: AgentRecord,
): Promise<ModelInfo | undefined> {
	const id = latestSession(record)?.id;
	const previous =
		record.modelInfo?.provider === record.provider && record.modelInfo.sessionId === id
			? record.modelInfo
			: undefined;
	const account = record.provider === 'claude' ? directoryKey(claudeConfigDirectory(record)) : '';
	const key = `${storageRoot()}:${slug}:${record.provider}:${account}:${id ?? ''}`;
	if (pending.has(key)) return pending.get(key);
	if (Date.now() - (checked.get(key) ?? 0) < 30000) return previous;
	checked.set(key, Date.now());
	const work = (async () => {
		// Seed the last reported value, including offline members, before inspecting this run.
		if (record.modelInfo) await recordModelHistory(slug, record.modelInfo);
		let info: ModelInfo | undefined;
		try {
			info = await readProviderModel(record, homedir(), slug);
			if (!info) return previous;
			const observation = info;
			if (JSON.stringify(info) !== JSON.stringify(previous))
				await updateAgentRecord(slug, (current) => {
					if (
						current.provider === observation.provider &&
						(current.provider !== 'claude' ||
							directoryKey(claudeConfigDirectory(current)) === account) &&
						latestSession(current)?.id === observation.sessionId
					)
						current.modelInfo = observation;
				});
		} catch {
			return previous;
		}
		await recordModelHistory(slug, info);
		return info;
	})();
	pending.set(key, work);
	try {
		return await work;
	} finally {
		pending.delete(key);
	}
}
