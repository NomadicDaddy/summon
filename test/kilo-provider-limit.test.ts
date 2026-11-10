import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { providerLimitFact } from '../src/desktop/member-facts.ts';
import { classifyKiloProviderLimit, readKiloProviderLimit } from '../src/kilo-provider-limit.ts';

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
