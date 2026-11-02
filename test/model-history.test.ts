import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelInfo } from '../src/model-info.ts';

import { recordModelHistory } from '../src/model-history.ts';

let root: string;
const previousHome = process.env.SUMMON_HOME;
const info: ModelInfo = {
	provider: 'codex',
	model: 'first',
	sessionId: 'first-run',
	observedAt: '2026-10-03T18:00:00Z',
};
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-model-history-'));
	process.env.SUMMON_HOME = root;
});
afterEach(async () => {
	if (previousHome === undefined) Reflect.deleteProperty(process.env, 'SUMMON_HOME');
	else process.env.SUMMON_HOME = previousHome;
	await rm(root, { recursive: true, force: true });
});
const path = () => join(root, 'runtime', 'probe', 'model-history.jsonl');
const lines = async () => (await readFile(path(), 'utf8')).trim().split('\n');

test('seeds once under concurrent refreshes and compares across runs without timestamp noise', async () => {
	await Promise.all(Array.from({ length: 6 }, () => recordModelHistory('probe', info)));
	await recordModelHistory('probe', {
		...info,
		sessionId: 'next-run',
		observedAt: '2026-10-03T19:00:00Z',
	});
	expect(await lines()).toHaveLength(1);
	await recordModelHistory('probe', { ...info, model: 'second', sessionId: 'next-run' });
	await recordModelHistory('probe', info);
	const entries = (await lines()).map((line) => JSON.parse(line) as Record<string, unknown>);
	expect(entries.map((entry) => entry.model)).toEqual(['first', 'second', 'first']);
	expect(entries.every((entry) => Number.isFinite(Date.parse(String(entry.loggedAt))))).toBe(
		true,
	);
	expect(entries[1]?.sessionId).toBe('next-run');
});

test('reasoning and capacity changes are retained, while repeated observations are not', async () => {
	await recordModelHistory('probe', info);
	await recordModelHistory('probe', { ...info, reasoning: 'high' });
	const capacity = { ...info, reasoning: 'high', contextWindow: 262144 };
	await recordModelHistory('probe', capacity);
	await recordModelHistory('probe', { ...capacity, observedAt: '2026-10-08T20:00:00Z' });
	await recordModelHistory('probe', { ...capacity, contextWindow: 1048576 });
	await recordModelHistory('probe', info);
	expect(await lines()).toHaveLength(5);
});

test('same model from a different provider is a change, corruption is preserved and surfaced', async () => {
	await recordModelHistory('probe', info);
	await recordModelHistory('probe', { ...info, provider: 'claude' });
	expect(await lines()).toHaveLength(2);
	await writeFile(path(), '{broken\n');
	expect(await recordModelHistory('probe', info).catch(String)).toContain('JSON');
	expect(await readFile(path(), 'utf8')).toBe('{broken\n');
});
