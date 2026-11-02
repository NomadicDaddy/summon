import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { codexCompactionReader } from '../src/codex-compaction-history.ts';
import * as readers from '../src/codex-compaction-history.ts';
import { waitForCodexBinding } from '../src/codex-mail-delivery.ts';
import { readCompactions } from '../src/compaction-history.ts';
import { runtimePath } from '../src/mail-session.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let home: string;
let path: string;
const oldHome = process.env.SUMMON_HOME;
const oldCodex = process.env.CODEX_HOME;
const thread = 'synthetic-thread-one';
const nonce = 'synthetic-codex-launch';
const event = {
	timestamp: '2026-01-01T00:00:00.000Z',
	type: 'compacted',
	payload: {
		window_id: 'synthetic-window',
		compaction_response_id: 'synthetic-response',
		replacement_history: 'PRIVATE_SENTINEL',
		encrypted_content: 'PRIVATE_SENTINEL',
	},
};
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	home = join(fixture.records, 'codex-profile');
	process.env.CODEX_HOME = home;
	await mkdir(join(home, 'sessions'), { recursive: true });
	path = join(home, 'sessions', 'synthetic.jsonl');
	const database = new Database(join(home, 'state_5.sqlite'));
	try {
		database.run('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT)');
		database
			.query('INSERT INTO threads VALUES (?, ?, ?)')
			.run(thread, path, 'PRIVATE_SENTINEL');
		database
			.query('INSERT INTO threads VALUES (?, ?, ?)')
			.run('foreign-thread', 'unread-foreign-path', 'PRIVATE_SENTINEL');
	} finally {
		database.close();
	}
	await mkdir(runtimePath('alpha'), { recursive: true });
	await writeFile(join(runtimePath('alpha'), `${nonce}.binding`), thread);
	await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: thread } }) + '\n');
});
afterEach(async () => {
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	if (oldCodex === undefined) delete process.env.CODEX_HOME;
	else process.env.CODEX_HOME = oldCodex;
	await fixture.dispose();
});

test('own exact bound rollout backfills metadata and deduplicates replay across resumed launches', async () => {
	await appendFile(path, JSON.stringify(event) + '\n');
	const scan = codexCompactionReader('alpha', nonce);
	await scan();
	await scan();
	const history = await readCompactions('alpha', 10);
	expect(history.retainedObservations).toBe(1);
	expect(history.entries[0]?.record.nativeAt).toBe(event.timestamp);
	expect(history.entries[0]?.record.phase).toBe('recorded');
	expect(history.entries[0]?.record.observedAt).not.toBe(event.timestamp);
	expect(JSON.stringify(history)).not.toContain('PRIVATE_SENTINEL');
	expect(JSON.stringify(history)).not.toContain(thread);
	await writeFile(join(runtimePath('alpha'), 'second-launch.binding'), thread);
	await codexCompactionReader('alpha', 'second-launch')();
	expect((await readCompactions('alpha', 10)).retainedObservations).toBe(1);
});

test('partial JSONL append is deferred until complete; unrelated messages are never retained', async () => {
	const scan = codexCompactionReader('alpha', nonce);
	await appendFile(
		path,
		JSON.stringify({ type: 'response_item', payload: { text: 'PRIVATE_SENTINEL' } }) + '\n',
	);
	const body = JSON.stringify(event);
	await appendFile(path, body.slice(0, 15));
	await scan();
	expect((await readCompactions('alpha', 10)).retainedObservations).toBe(0);
	await appendFile(path, body.slice(15) + '\n');
	await scan();
	expect((await readCompactions('alpha', 10)).retainedObservations).toBe(1);
});

test.each(['wrong-header', 'outside-root', 'missing-binding'] as const)(
	'%s cannot retain another conversation or initialize history',
	async (kind) => {
		if (kind === 'wrong-header')
			await writeFile(
				path,
				JSON.stringify({ type: 'session_meta', payload: { id: 'foreign-thread' } }) +
					'\n' +
					JSON.stringify(event) +
					'\n',
			);
		if (kind === 'outside-root') {
			const database = new Database(join(home, 'state_5.sqlite'));
			try {
				database
					.query('UPDATE threads SET rollout_path = ? WHERE id = ?')
					.run(join(fixture.records, 'private.jsonl'), thread);
			} finally {
				database.close();
			}
		}
		if (kind === 'missing-binding')
			await writeFile(join(runtimePath('alpha'), `${nonce}.binding`), '');
		await codexCompactionReader('alpha', nonce)();
		expect((await readCompactions('alpha', 10)).retainedObservations).toBe(0);
	},
);

test('a replaced rollout cannot inherit the verified header of the previous file', async () => {
	const scan = codexCompactionReader('alpha', nonce);
	await scan();
	await rename(path, `${path}.preserved`);
	await writeFile(
		path,
		JSON.stringify({ type: 'session_meta', payload: { id: 'foreign-thread' } }) +
			'\n' +
			JSON.stringify(event) +
			'\n',
	);
	await scan();
	expect((await readCompactions('alpha', 10)).retainedObservations).toBe(0);
});

test.each(['foreign-header', 'same-header-regrowth'] as const)(
	'in-place %s cannot reuse a previously verified cursor',
	async (kind) => {
		const before =
			JSON.stringify({ type: 'response_item', payload: { text: 'old-marker' } }) + '\n';
		await appendFile(path, before);
		const scan = codexCompactionReader('alpha', nonce);
		await scan();
		const id = kind === 'foreign-header' ? 'synthetic-thread-two' : thread;
		const changed =
			JSON.stringify({ type: 'response_item', payload: { text: 'new-marker' } }) + '\n';
		await writeFile(
			path,
			JSON.stringify({ type: 'session_meta', payload: { id } }) +
				'\n' +
				changed +
				JSON.stringify(event) +
				'\n',
		);
		await scan();
		expect((await readCompactions('alpha', 10)).retainedObservations).toBe(0);
	},
);

test('shutdown consumer can drain a large own snapshot in bounded ticks without losing a trailing compaction', async () => {
	const unrelated =
		JSON.stringify({
			type: 'response_item',
			payload: { text: 'PRIVATE_SENTINEL'.repeat(10000) },
		}) + '\n';
	await appendFile(path, unrelated.repeat(4) + JSON.stringify(event) + '\n');
	const scan = codexCompactionReader('alpha', nonce);
	expect(await scan()).toBe(false);
	expect(await scan()).toBe(true);
	expect((await readCompactions('alpha', 10)).retainedObservations).toBe(1);
});

test('growing large backfill and idle polls remain incremental; later rewrite is still refused', async () => {
	const row =
		JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(128 * 1024) } }) + '\n';
	await appendFile(path, row.repeat(128) + JSON.stringify(event) + '\n');
	const scan = codexCompactionReader('alpha', nonce);
	let ticks = 0;
	while (!(await scan())) {
		if (++ticks > 40) throw new Error('Backfill did not advance.');
		await appendFile(path, JSON.stringify({ type: 'progress' }) + '\n');
	}
	expect(ticks).toBeGreaterThan(30);
	for (let index = 0; index < 20; index++) expect(await scan()).toBe(true);
	for (let index = 0; index < 20; index++) {
		await appendFile(path, JSON.stringify({ type: 'progress' }) + '\n');
		expect(await scan()).toBe(true);
	}
	expect((await readCompactions('alpha', 10)).retainedObservations).toBe(1);
	await writeFile(
		path,
		JSON.stringify({ type: 'session_meta', payload: { id: thread } }) +
			'\n' +
			row.replace('xxx', 'yyy').repeat(129) +
			JSON.stringify({ ...event, payload: { ...event.payload, window_id: 'new' } }) +
			'\n',
	);
	let rewrittenTicks = 0;
	while (!(await scan())) {
		if (++rewrittenTicks > 40) throw new Error('Rewritten backfill did not settle.');
	}
	expect((await readCompactions('alpha', 10)).retainedObservations).toBe(1);
});

test('several compactions in a growing backfill retain once; a later shrink cannot add evidence', async () => {
	const row = JSON.stringify({ type: 'progress', text: 'x'.repeat(128 * 1024) }) + '\n';
	for (let index = 0; index < 4; index++) {
		await appendFile(
			path,
			row.repeat(8) +
				JSON.stringify({
					...event,
					payload: { ...event.payload, window_id: `window-${index}` },
				}) +
				'\n',
		);
	}
	const scan = codexCompactionReader('alpha', nonce);
	let ticks = 0;
	while (!(await scan())) {
		if (++ticks > 20) throw new Error('Growing backfill did not settle.');
		await appendFile(path, row);
	}
	expect((await readCompactions('alpha', 10)).retainedObservations).toBe(4);
	await writeFile(
		path,
		JSON.stringify({ type: 'session_meta', payload: { id: thread } }) +
			'\n' +
			JSON.stringify(event) +
			'\n',
	);
	expect(await scan()).toBe(true);
	expect((await readCompactions('alpha', 10)).retainedObservations).toBe(4);
});

test('shutdown does not drain an unbounded backlog', async () => {
	let calls = 0;
	const reader = spyOn(readers, 'codexCompactionReader').mockReturnValue(() => {
		calls++;
		return Promise.resolve(false);
	});
	const warning = spyOn(console, 'error').mockImplementation(() => {});
	try {
		await waitForCodexBinding('alpha', nonce)();
		expect(calls).toBe(8);
		expect(warning).toHaveBeenCalledWith(
			'Codex compaction backfill remains incomplete; it can resume on the next launch.',
		);
	} finally {
		reader.mockRestore();
		warning.mockRestore();
	}
});
