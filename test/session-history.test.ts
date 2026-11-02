import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Team } from '../src/desktop/team.ts';
import { appendSessionTransition, readSessionHistory } from '../src/session-history.ts';
import { loadAgent, providers, saveAgent } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

test.each([...providers])(
	'%s: actual owning lifecycle retains ordered stops and linked relaunches',
	async (provider) => {
		const record = await loadAgent('alpha');
		if (!record) throw new Error('Missing member');
		record.provider = provider;
		await saveAgent('alpha', record);
		let ended: (event: { exitCode: number }) => void = () => {};
		let writes = 0;
		const team = new Team(
			'bun',
			'cli.ts',
			() => {},
			() => ({
				pid: 1,
				onData: () => ({ dispose() {} }),
				onExit: (callback) => {
					ended = callback;
					return { dispose() {} };
				},
				write: () => {
					writes++;
				},
				resize() {},
				kill: () => ended({ exitCode: 0 }),
			}),
			() => {
				ended({ exitCode: 0 });
				return Promise.resolve();
			},
		);
		await team.start('alpha', false);
		const first = team.sessions.get('alpha')?.launch.nonce;
		await team.stop('alpha', 'rest-work');
		await team.start('alpha', false, 'rest-work');
		const second = team.sessions.get('alpha')?.launch.nonce;
		expect(first).not.toBe(second);
		await team.shutdown();
		const history = await readSessionHistory({ limit: 20, member: 'alpha' });
		const chronological = [...history.entries].reverse();
		expect(chronological.map((entry) => entry.state)).toEqual([
			'started',
			'stop-requested',
			'stopped',
			'started',
			'stop-requested',
			'stopped',
		]);
		expect(chronological[0]?.nonce).toBe(first);
		expect(chronological[3]?.previousNonce).toBe(first);
		expect(chronological[3]?.nonce).toBe(second);
		expect(chronological[3]?.reason).toBe('rest-work');
		expect(chronological[4]?.reason).toBe('window-close');
		expect(chronological.every((entry) => entry.provider === provider && entry.pid === 1)).toBe(
			true,
		);
		expect(writes).toBe(0);
		const bytes = await fixture.read('logs/session-history.json');
		const cli = await fixture.run(
			['--session-history', '--member', 'alpha', '--limit', '2'],
			'alpha',
		);
		expect(cli.code).toBe(0);
		const result = JSON.parse(cli.out) as {
			entries: unknown[];
			more: boolean;
			readOnly: boolean;
			next: string;
		};
		expect(result.entries).toHaveLength(2);
		expect(result.more).toBe(true);
		expect(result.readOnly).toBe(true);
		const older = await fixture.run(
			['--session-history', '--member', 'alpha', '--limit', '2', '--before', result.next],
			'alpha',
		);
		expect(older.code).toBe(0);
		const olderResult = JSON.parse(older.out) as { entries: { state: string }[] };
		expect(olderResult.entries.map((entry) => entry.state)).toEqual(['started', 'stopped']);
		expect(await fixture.read('logs/session-history.json')).toBe(bytes);
	},
);

test('failed stop remains running and records failure, while subsequent natural exit is not a stop', async () => {
	let ended: (event: { exitCode: number }) => void = () => {};
	const team = new Team(
		'bun',
		'cli.ts',
		() => {},
		() => ({
			pid: 1,
			onData: () => ({ dispose() {} }),
			onExit: (callback) => {
				ended = callback;
				return { dispose() {} };
			},
			write() {},
			resize() {},
			kill: () => {
				throw new Error('Stop refused');
			},
		}),
		() => Promise.reject(new Error('Stop refused')),
	);
	await team.start('alpha', false);
	const failure: unknown = await team.stop('alpha').catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(Error);
	if (!(failure instanceof Error)) throw new Error('Missing stop failure');
	expect(failure.message).toContain('Stop refused');
	expect(team.sessions.get('alpha')?.agent.status).toBe('running');
	ended({ exitCode: 17 });
	await team.shutdown();
	const history = await readSessionHistory({ limit: 20 });
	expect(history.entries.map((entry) => entry.state).reverse()).toEqual([
		'started',
		'stop-requested',
		'stop-failed',
		'exited',
	]);
	expect(history.entries[0]?.exitCode).toBe(17);
});

test('failed retention is visible without preventing an owned stop or overwriting damaged history', async () => {
	await appendSessionTransition(
		{
			member: 'alpha',
			provider: 'codex',
			nonce: randomUUID(),
			state: 'started',
			reason: 'operator',
		},
		new Date().toISOString(),
		fixture.records,
	);
	const path = join(fixture.records, 'logs/session-history.json');
	await writeFile(path, '{damaged');
	const faults: string[] = [];
	let ended: (event: { exitCode: number }) => void = () => {};
	const team = new Team(
		'bun',
		'cli.ts',
		(event) => {
			if (event.type === 'error') faults.push(event.message);
		},
		() => ({
			pid: 1,
			onData: () => ({ dispose() {} }),
			onExit: (callback) => {
				ended = callback;
				return { dispose() {} };
			},
			write() {},
			resize() {},
			kill: () => ended({ exitCode: 0 }),
		}),
		() => {
			ended({ exitCode: 0 });
			return Promise.resolve();
		},
	);
	await team.start('alpha', false);
	await team.shutdown();
	expect(team.sessions.get('alpha')?.agent.status).toBe('stopped');
	expect(
		faults.filter((text) => text.includes('Session history could not be saved')),
	).toHaveLength(1);
	expect(await readFile(path, 'utf8')).toBe('{damaged');
});

test('damaged history is preserved and rejects appends; malformed reader options fail', async () => {
	await appendSessionTransition(
		{
			member: 'alpha',
			provider: 'codex',
			nonce: randomUUID(),
			state: 'started',
			reason: 'operator',
		},
		new Date().toISOString(),
		fixture.records,
	);
	const path = join(fixture.records, 'logs/session-history.json');
	await writeFile(path, '{damaged');
	const failure: unknown = await appendSessionTransition(
		{
			member: 'alpha',
			provider: 'codex',
			nonce: randomUUID(),
			state: 'started',
			reason: 'operator',
		},
		new Date().toISOString(),
		fixture.records,
	).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(Error);
	if (!(failure instanceof Error)) throw new Error('Missing history refusal');
	expect(failure.message).toContain('damaged');
	expect(await readFile(path, 'utf8')).toBe('{damaged');
	expect((await fixture.run(['--session-history', '--limit', '0'], 'alpha')).code).toBe(1);
	expect((await fixture.run(['--session-history', '--member', '../alpha'], 'alpha')).code).toBe(
		1,
	);
});
