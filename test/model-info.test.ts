import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { modelEvent, readProviderModel, refreshModelInfo } from '../src/provider-model-info.ts';
import {
	loadAgent,
	newRecord,
	rememberSession,
	saveAgent,
	updateAgentRecord,
} from '../src/store.ts';

let root: string;
const keys = ['SUMMON_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_DATA_HOME'] as const;
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-model-'));
	process.env.SUMMON_HOME = join(root, 'team');
	process.env.CODEX_HOME = join(root, '.codex');
	process.env.CLAUDE_CONFIG_DIR = join(root, '.claude');
	process.env.XDG_DATA_HOME = join(root, '.local', 'share');
});
afterEach(async () => {
	for (const key of keys) {
		if (previous[key] === undefined) Reflect.deleteProperty(process.env, key);
		else process.env[key] = previous[key];
	}
	Bun.gc(true);
	await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function write(path: string, text: string) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text);
}
test('exact Claude session ignores synthetic and sidechain replies, and never returns content', async () => {
	const record = newRecord('probe', 'D:\\project', 'claude');
	rememberSession(record, 'claude-id');
	const rows = [
		{
			type: 'assistant',
			sessionId: 'claude-id',
			effort: 'high',
			message: { model: 'opus', content: 'private' },
		},
		{ type: 'assistant', sessionId: 'different', message: { model: 'wrong' } },
		{
			type: 'assistant',
			sessionId: 'claude-id',
			isSidechain: true,
			message: { model: 'child' },
		},
		{ type: 'assistant', sessionId: 'claude-id', message: { model: '<synthetic>' } },
	];
	await write(
		join(root, '.claude', 'projects', 'D--project', 'claude-id.jsonl'),
		rows.map((row) => JSON.stringify(row)).join('\n') + '\n{"partial":',
	);
	const info = await readProviderModel(record, root);
	expect(info?.model).toBe('opus');
	expect(info?.reasoning).toBe('high');
	expect(JSON.stringify(info)).not.toContain('private');
});
test('Claude finds an exact resumed session in its original project after cwd changes', async () => {
	const record = newRecord('probe', 'D:\\new-project', 'claude');
	rememberSession(record, 'resumed-id');
	await write(
		join(root, '.claude', 'projects', 'D--original-project', 'resumed-id.jsonl'),
		JSON.stringify({
			type: 'assistant',
			sessionId: 'resumed-id',
			effort: 'high',
			message: { model: 'opus', content: 'private original conversation' },
		}),
	);
	await write(
		join(root, '.claude', 'projects', 'D--new-project', 'unrelated-id.jsonl'),
		JSON.stringify({
			type: 'assistant',
			sessionId: 'unrelated-id',
			message: { model: 'wrong' },
		}),
	);
	expect(await readProviderModel(record, root)).toMatchObject({
		model: 'opus',
		reasoning: 'high',
	});
	const info = await readProviderModel(record, root);
	expect(JSON.stringify(info)).not.toContain('private original conversation');
	rememberSession(record, 'missing-id');
	expect(await readProviderModel(record, root)).toBeUndefined();
});

test('Codex newest turn wins; persisted observation survives stale profile saves and session changes hide cache', async () => {
	const record = newRecord('probe', root, 'codex');
	rememberSession(record, 'codex-id');
	await saveAgent('probe', record);
	await write(
		join(root, '.codex', 'sessions', '2026', '09', '29', 'rollout-codex-id.jsonl'),
		[
			{ type: 'turn_context', payload: { model: 'old', effort: 'low' } },
			{ type: 'turn_context', payload: { model: 'new', effort: 'high' } },
		]
			.map((row) => JSON.stringify(row))
			.join('\n'),
	);
	const info = await refreshModelInfo('probe', record);
	expect(info?.model).toBe('new');
	await updateAgentRecord('probe', (current) => {
		current.expertise = 'concurrent edit';
	});
	expect((await loadAgent('probe'))?.expertise).toBe('concurrent edit');
	await saveAgent('probe', record);
	expect((await loadAgent('probe'))?.modelInfo).toEqual(info);
	rememberSession(record, 'other-id');
	expect(await refreshModelInfo('probe', record)).toBeUndefined();
});
test('Kilo query reads only the registered session and persisted variant using real SQLite', async () => {
	const record = newRecord('probe', root, 'kilo');
	rememberSession(record, 'kilo-id');
	const path = join(root, '.local', 'share', 'kilo', 'kilo.db');
	await mkdir(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec('CREATE TABLE session (id TEXT, directory TEXT, model TEXT, time_updated INTEGER)');
	db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run(
		'kilo-id',
		root,
		JSON.stringify({ id: 'glm', providerID: 'zai', variant: 'default' }),
		Date.now(),
	);
	db.close();
	expect(await readProviderModel(record, root)).toMatchObject({
		model: 'zai/glm',
		reasoning: 'default',
	});
	record.cwd = 'other-directory';
	expect(await readProviderModel(record, root)).toBeUndefined();
});

test('Codex capacity is tied to the latest model turn and drops when that turn has no evidence', async () => {
	const record = newRecord('probe', root, 'codex');
	rememberSession(record, 'codex-id');
	const path = join(root, '.codex', 'sessions', 'rollout-codex-id.jsonl');
	const started = (turn: string, capacity: unknown, thread = 'codex-id') => ({
		type: 'event_msg',
		payload: {
			type: 'task_started',
			turn_id: turn,
			thread_id: thread,
			model_context_window: capacity,
		},
	});
	const context = (turn: string) => ({
		type: 'turn_context',
		payload: { turn_id: turn, model: turn },
	});
	const rows: unknown[] = [
		started('old', 262144),
		context('old'),
		started('new', 1048576),
		context('new'),
	];
	const save = () => write(path, rows.map((row) => JSON.stringify(row)).join('\n'));
	await save();
	expect(await readProviderModel(record, root)).toMatchObject({
		model: 'new',
		contextWindow: 1048576,
	});
	for (const capacity of [null, 0, -1, 1.5, '1048576', Number.MAX_SAFE_INTEGER + 1]) {
		rows.push(started('new', capacity));
		await save();
		expect((await readProviderModel(record, root))?.contextWindow).toBeUndefined();
	}
	rows.push(started('new', 262144, 'different'));
	await save();
	expect((await readProviderModel(record, root))?.contextWindow).toBeUndefined();
	rows.push(context('latest'), {
		type: 'event_msg',
		payload: { type: 'token_count', info: { model_context_window: 262144 } },
	});
	await save();
	expect(await readProviderModel(record, root)).toMatchObject({ model: 'latest' });
	expect((await readProviderModel(record, root))?.contextWindow).toBeUndefined();
});
test('Grok saved settings and missing effort remain explicit; arbitrary events cannot invent settings', async () => {
	const record = newRecord('probe', root, 'grok');
	rememberSession(record, 'grok-id');
	await write(
		join(root, '.grok', 'sessions', encodeURIComponent(root), 'grok-id', 'summary.json'),
		JSON.stringify({ current_model_id: 'grok', reasoning_effort: 'high' }),
	);
	expect(await readProviderModel(record, root)).toMatchObject({
		model: 'grok',
		reasoning: 'high',
	});
	const summary = join(
		root,
		'.grok',
		'sessions',
		encodeURIComponent(root),
		'grok-id',
		'summary.json',
	);
	await write(summary, JSON.stringify({ current_model_id: 'grok', context_window: 262144 }));
	expect((await readProviderModel(record, root))?.contextWindow).toBe(262144);
	for (const value of [undefined, 0, -1, 1.5, '262144', Number.MAX_SAFE_INTEGER + 1]) {
		await write(summary, JSON.stringify({ current_model_id: 'grok', context_window: value }));
		expect((await readProviderModel(record, root))?.contextWindow).toBeUndefined();
	}
	expect(
		modelEvent('codex', { type: 'response_item', payload: { model: 'injected' } }, 'id'),
	).toBeUndefined();
});
