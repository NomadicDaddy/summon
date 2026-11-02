import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { readCodexThreadStatuses } from '../src/codex-turn-rpc.ts';
import { processAlive } from '../src/process-owner.ts';

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-codex-status-'));
});
afterEach(async () => {
	if (
		dirname(resolve(root)) !== resolve(tmpdir()) ||
		!basename(root).startsWith('summon-codex-status-')
	)
		throw new Error('Invalid fixture cleanup path.');
	await rm(root, { recursive: true, force: true });
});
const fixture = join(import.meta.dirname, 'fixtures/codex-status-proxy.ts');
const command = (mode: string, record?: string) => [
	process.execPath,
	fixture,
	mode,
	...(record ? [record] : []),
];

test('one initialized connection reads only exact thread metadata, not histories', async () => {
	const record = join(root, 'requests.jsonl');
	const phases = await readCodexThreadStatuses(
		['busy-one', 'idle-two'],
		command('normal', record),
	);
	expect([...phases]).toEqual([
		['busy-one', 'busy'],
		['idle-two', 'idle'],
	]);
	const requests = (await readFile(record, 'utf8'))
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as unknown);
	expect(requests).toEqual([
		{
			id: 1,
			method: 'initialize',
			params: { clientInfo: { name: 'summon_turn_observer', version: '1.0.0' } },
		},
		{ method: 'initialized', params: {} },
		{ id: 2, method: 'thread/read', params: { threadId: 'busy-one', includeTurns: false } },
		{ id: 3, method: 'thread/read', params: { threadId: 'idle-two', includeTurns: false } },
	]);
	const pid = Number(await readFile(`${record}.pid`, 'utf8'));
	expect(processAlive(pid)).toBe(false);
});

test.each([
	'notLoaded',
	'systemError',
	'new-status',
	'error',
	'mismatch',
	'malformed',
	'oversize',
	'invalid-utf8',
	'init-error',
	'exit',
])('%s cannot authorize idle', async (mode) => {
	const thread = mode === 'mismatch' || mode === 'error' ? 'idle-one' : 'unknown-thread';
	expect((await readCodexThreadStatuses([thread], command(mode))).get(thread)).toBe('unknown');
});

test('silence is bounded and its fixture process is reaped', async () => {
	const record = join(root, 'hang.jsonl');
	const start = performance.now();
	expect(
		(await readCodexThreadStatuses(['idle-one'], command('hang', record))).get('idle-one'),
	).toBe('unknown');
	expect(performance.now() - start).toBeLessThan(4000);
	const pid = Number(await readFile(`${record}.pid`, 'utf8'));
	expect(processAlive(pid)).toBe(false);
});

test('empty, duplicate, oversized and invalid selections never start the fixture', async () => {
	const missing = command('hang', join(root, 'must-not-run'));
	await readCodexThreadStatuses([], missing);
	await readCodexThreadStatuses(['same', 'same'], missing);
	await readCodexThreadStatuses(['../foreign'], missing);
	await readCodexThreadStatuses(
		Array.from({ length: 65 }, (_, i) => `thread-${i}`),
		missing,
	);
	expect(await Bun.file(join(root, 'must-not-run.pid')).exists()).toBe(false);
});

test('missing executable is unknown without surfacing provider diagnostics', async () => {
	expect(
		(await readCodexThreadStatuses(['idle-one'], [join(root, 'missing.exe')])).get('idle-one'),
	).toBe('unknown');
});
