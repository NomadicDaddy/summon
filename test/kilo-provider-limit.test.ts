import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { TeamAgent } from '../src/desktop/types.ts';

import { providerLimitFact } from '../src/desktop/member-facts.ts';
import { teamSnapshot } from '../src/desktop/team-snapshot.ts';
import {
	classifyKiloProviderLimit,
	currentKiloProviderLimit,
	readKiloProviderLimit,
} from '../src/kilo-provider-limit.ts';
import { initializeKiloTurn } from '../src/kilo-turn-state.ts';
import { newRecord, saveAgent } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

const session = 'ses_fixture';
const directory = join(tmpdir(), 'summon-kilo-project');
const completed = (at: number, error?: unknown): object => ({
	role: 'assistant',
	providerID: 'zai-coding-plan',
	time: { created: at - 1000, completed: at },
	...(error ? { error } : { finish: 'stop' }),
});
const limitError = (code = '1310'): object => ({
	name: 'APIError',
	data: {
		statusCode: 429,
		responseHeaders: { authorization: 'PRIVATE_SENTINEL' },
		responseBody: JSON.stringify({ error: { code, message: 'PRIVATE_SENTINEL' } }),
	},
});

test('Kilo limit classification retains only a validated completed error and time', () => {
	const at = Date.now() - 10_000;
	const limit = classifyKiloProviderLimit(completed(at, limitError()), at, at - 1000);
	if (!limit) throw new Error('Expected a validated provider limit');
	expect(limit).toEqual({
		provider: 'zai-coding-plan',
		status: 429,
		code: '1310',
		observedAt: new Date(at).toISOString(),
	});
	expect(JSON.stringify(limit)).not.toContain('PRIVATE_SENTINEL');
	expect(providerLimitFact({ providerLimit: limit })).toContain('Provider limit observed');
	expect(providerLimitFact({ providerLimit: limit })).not.toContain('PRIVATE_SENTINEL');
	expect(
		classifyKiloProviderLimit(completed(at, limitError('other')), at, at - 1000),
	).toBeUndefined();
	expect(classifyKiloProviderLimit(completed(at, limitError()), at, at + 1)).toBeUndefined();
	expect(
		classifyKiloProviderLimit(completed(at - 1000, limitError()), at, at - 500),
	).toBeUndefined();
	expect(
		classifyKiloProviderLimit({ role: 'assistant', error: limitError() }, at, at - 1000),
	).toBeUndefined();
	expect(
		classifyKiloProviderLimit(
			completed(at, {
				name: 'APIError',
				data: { statusCode: 429, responseBody: '{' },
			}),
			at,
			at - 1000,
		),
	).toBeUndefined();
	expect(providerLimitFact({ providerLimitError: true })).toBe(
		'Provider limit observation unavailable',
	);
});

test('the latest completed assistant success clears an earlier limit for the exact session', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-kilo-limit-'));
	const path = join(root, 'kilo.db');
	const db = new DatabaseSync(path);
	const now = Date.now() - 10_000;
	try {
		db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)');
		db.exec('CREATE TABLE message (session_id TEXT, data TEXT, time_updated INTEGER)');
		db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run(session, directory);
		const insert = db.prepare(
			'INSERT INTO message (session_id, data, time_updated) VALUES (?, ?, ?)',
		);
		insert.run(session, JSON.stringify(completed(now, limitError())), now);
		expect(() =>
			readKiloProviderLimit(directory, session, now - 1000, join(root, 'missing.db')),
		).toThrow();
		expect(readKiloProviderLimit(directory, session, now - 1000, path)?.code).toBe('1310');
		expect(
			readKiloProviderLimit(join(root, 'other'), session, now - 1000, path),
		).toBeUndefined();
		expect(
			readKiloProviderLimit(directory, 'another-session', now - 1000, path),
		).toBeUndefined();
		expect(readKiloProviderLimit(directory, session, now + 1, path)).toBeUndefined();
		insert.run(session, JSON.stringify(completed(now + 1000, limitError('other'))), now + 1000);
		expect(readKiloProviderLimit(directory, session, now - 1000, path)?.observedAt).toBe(
			new Date(now).toISOString(),
		);
		insert.run(session, JSON.stringify(completed(now + 2000, limitError())), now + 2500);
		expect(readKiloProviderLimit(directory, session, now - 1000, path)?.observedAt).toBe(
			new Date(now + 2000).toISOString(),
		);
		insert.run(session, JSON.stringify(completed(now + 3000, limitError('other'))), now + 3000);
		expect(readKiloProviderLimit(directory, session, now - 1000, path)?.observedAt).toBe(
			new Date(now + 2000).toISOString(),
		);
		insert.run(
			session,
			JSON.stringify({ ...completed(now + 3700), finish: 'length' }),
			now + 3700,
		);
		expect(readKiloProviderLimit(directory, session, now - 1000, path)).toBeUndefined();
		insert.run(session, JSON.stringify(completed(now + 4000)), now + 4000);
		expect(readKiloProviderLimit(directory, session, now - 1000, path)).toBeUndefined();
		insert.run(session, JSON.stringify(completed(now + 3500, limitError())), now + 5000);
		expect(readKiloProviderLimit(directory, session, now - 1000, path)).toBeUndefined();
	} finally {
		db.close();
		Bun.gc(true);
		await Bun.sleep(250);
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test('the scan bound refuses undecided history but accepts a decision inside it', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-kilo-limit-'));
	const path = join(root, 'kilo.db');
	const db = new DatabaseSync(path);
	const now = Date.now() - 500_000;
	try {
		db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)');
		db.exec('CREATE TABLE message (session_id TEXT, data TEXT, time_updated INTEGER)');
		db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run(session, directory);
		const insert = db.prepare(
			'INSERT INTO message (session_id, data, time_updated) VALUES (?, ?, ?)',
		);
		for (let index = 0; index < 257; index++) {
			const at = now + index;
			insert.run(session, JSON.stringify(completed(at, limitError('other'))), at);
		}
		expect(() => readKiloProviderLimit(directory, session, now - 1, path)).toThrow(
			'scan bound',
		);
		insert.run(session, JSON.stringify(completed(now + 258, limitError())), now + 258);
		expect(readKiloProviderLimit(directory, session, now - 1, path)?.code).toBe('1310');
	} finally {
		db.close();
		Bun.gc(true);
		await Bun.sleep(250);
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test('the current launch binds its turn, start time, and cache to the exact nonce', async () => {
	const fixture = await mailHarness();
	const priorHome = process.env.SUMMON_HOME;
	const priorAgent = process.env.SUMMON_AGENT;
	const priorNonce = process.env.SUMMON_NONCE;
	const priorDataHome = process.env.XDG_DATA_HOME;
	const path = join(fixture.root, 'kilo', 'kilo.db');
	const now = Date.now() - 10_000;
	try {
		process.env.SUMMON_HOME = fixture.records;
		process.env.SUMMON_AGENT = 'alpha';
		process.env.SUMMON_NONCE = 'launch-one';
		process.env.XDG_DATA_HOME = fixture.root;
		await mkdir(join(fixture.root, 'kilo'));
		const db = new DatabaseSync(path);
		try {
			db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)');
			db.exec('CREATE TABLE message (session_id TEXT, data TEXT, time_updated INTEGER)');
			db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run(session, directory);
			db.prepare('INSERT INTO message (session_id, data, time_updated) VALUES (?, ?, ?)').run(
				session,
				JSON.stringify(completed(now, limitError())),
				now,
			);
		} finally {
			db.close();
		}
		const record = newRecord('alpha', directory, 'kilo');
		record.sessions.push({
			id: session,
			createdAt: new Date(now).toISOString(),
			lastUsedAt: new Date(now).toISOString(),
		});
		const since = new Date(now - 1000).toISOString();
		expect(
			await currentKiloProviderLimit('alpha', 'launch-one', since, record),
		).toBeUndefined();
		await initializeKiloTurn('alpha', 'wrong-thread', 'another-session');
		expect(
			await currentKiloProviderLimit('alpha', 'wrong-thread', since, record),
		).toBeUndefined();
		await initializeKiloTurn('alpha', 'launch-one', session);
		expect(
			await currentKiloProviderLimit('alpha', 'launch-one', 'invalid', record),
		).toBeUndefined();
		expect((await currentKiloProviderLimit('alpha', 'launch-one', since, record))?.code).toBe(
			'1310',
		);
		await initializeKiloTurn('alpha', 'launch-two', session);
		expect(
			await currentKiloProviderLimit(
				'alpha',
				'launch-two',
				new Date(now + 1).toISOString(),
				record,
			),
		).toBeUndefined();
	} finally {
		if (priorHome === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = priorHome;
		if (priorAgent === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = priorAgent;
		if (priorNonce === undefined) delete process.env.SUMMON_NONCE;
		else process.env.SUMMON_NONCE = priorNonce;
		if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = priorDataHome;
		Bun.gc(true);
		await Bun.sleep(250);
		await fixture.dispose();
	}
});

test('a running Kilo row labels failed observation without degrading the whole snapshot', async () => {
	const fixture = await mailHarness();
	const priorHome = process.env.SUMMON_HOME;
	const priorAgent = process.env.SUMMON_AGENT;
	const priorNonce = process.env.SUMMON_NONCE;
	const priorDataHome = process.env.XDG_DATA_HOME;
	const nonce = 'snapshot-limit';
	try {
		process.env.SUMMON_HOME = fixture.records;
		process.env.SUMMON_AGENT = 'alpha';
		process.env.SUMMON_NONCE = nonce;
		process.env.XDG_DATA_HOME = fixture.root;
		const record = newRecord('alpha', directory, 'kilo');
		const since = new Date().toISOString();
		record.sessions.push({ id: session, createdAt: since, lastUsedAt: since });
		await saveAgent('alpha', record);
		await initializeKiloTurn('alpha', nonce, session);
		const agent: TeamAgent = {
			slug: 'alpha',
			name: 'Alpha',
			provider: 'kilo',
			cwd: directory,
			status: 'running',
		};
		delete process.env.SUMMON_AGENT;
		delete process.env.SUMMON_NONCE;
		const row = (
			await teamSnapshot({
				sessions: new Map([['alpha', { agent, launch: { nonce, since } }]]),
				reported: new Set<string>(),
				emit: () => {},
				startedAt: since,
				selected: 'alpha',
			})
		).agents.find((value) => value.slug === 'alpha');
		expect(row?.providerLimitError).toBe(true);
		expect(row?.providerLimit).toBeUndefined();
		expect(row?.observationUnavailable).toBeUndefined();
		expect(providerLimitFact(row ?? {})).toBe('Provider limit observation unavailable');
	} finally {
		if (priorHome === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = priorHome;
		if (priorAgent === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = priorAgent;
		if (priorNonce === undefined) delete process.env.SUMMON_NONCE;
		else process.env.SUMMON_NONCE = priorNonce;
		if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = priorDataHome;
		await fixture.dispose();
	}
});
