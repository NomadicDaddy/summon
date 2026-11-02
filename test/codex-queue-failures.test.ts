import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { queueRecorded } from '../src/codex-mail-delivery.ts';
import {
	CodexQueueError,
	queueFailureView,
	recordQueueFailure,
} from '../src/codex-queue-failures.ts';
import { scopedMail } from '../src/mailbox-commands.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
	path: process.env.PATH,
};
const NONCE = 'queue-fixture';
const SENTINEL = 'SYNTHETIC-SENTINEL-sk-1111';
const store = (): string =>
	join(fixture.records, 'runtime', 'alpha', `${NONCE}.codex-queue-failures.json`);
const exit = (code: number): CodexQueueError => new CodexQueueError('exit', code, 'unclassified');

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = NONCE;
});
afterEach(async () => {
	if (previous.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous.home;
	if (previous.agent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previous.agent;
	if (previous.nonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = previous.nonce;
	if (previous.path === undefined) delete process.env.PATH;
	else process.env.PATH = previous.path;
	await fixture.dispose();
});

test('the store keeps the newest twenty fixed labels for its own launch', async () => {
	expect(await queueFailureView('alpha', NONCE)).toEqual({ retained: 0, latest: null });
	for (let code = 1; code <= 21; code++) await recordQueueFailure('alpha', NONCE, exit(code));
	const view = await queueFailureView('alpha', NONCE);
	expect(view).toMatchObject({ retained: 20, latest: { outcome: 'exit', exitCode: 21 } });
	const saved = JSON.parse(await readFile(store(), 'utf8')) as {
		entries: { exitCode: number }[];
	};
	expect(saved.entries[0]?.exitCode).toBe(2);
	expect(Object.keys(saved).sort()).toEqual(['entries', 'nonce', 'owner', 'version']);
});

test('concurrent failures are all kept', async () => {
	await Promise.all(
		Array.from({ length: 12 }, (_, index) => recordQueueFailure('alpha', NONCE, exit(index))),
	);
	expect(await queueFailureView('alpha', NONCE)).toHaveProperty('retained', 12);
});

test('a malformed or foreign store is reported invalid, left unchanged and never echoed', async () => {
	await mkdir(join(fixture.records, 'runtime', 'alpha'), { recursive: true });
	for (const raw of [
		`{"version":1,"owner":"alpha","nonce":"${NONCE}","entries":[],"note":"${SENTINEL}"}`,
		`{"version":1,"owner":"beta","nonce":"${NONCE}","entries":[]}`,
		`not json ${SENTINEL}`,
	]) {
		await writeFile(store(), raw);
		expect(await queueFailureView('alpha', NONCE)).toEqual({ invalid: true });
		const refusal = await recordQueueFailure('alpha', NONCE, exit(1)).catch(
			(error: unknown) => error,
		);
		expect(String(refusal)).toBe(
			'Error: Codex queue diagnostics store is invalid; it was left unchanged.',
		);
		expect(await readFile(store(), 'utf8')).toBe(raw);
	}
});

test('another identity or an unsafe nonce cannot reach a store', async () => {
	for (const [name, nonce] of [
		['beta', NONCE],
		['alpha', '../escape'],
	])
		expect(
			await recordQueueFailure(name ?? '', nonce ?? '', exit(1)).catch(
				(error: unknown) => error,
			),
		).toBeInstanceOf(Error);
	expect(await Bun.file(store()).exists()).toBe(false);
});

test('a store write failure leaves the send result exactly as it was', async () => {
	await mkdir(store(), { recursive: true });
	const bin = await mkdtemp(join(tmpdir(), 'summon-queue-'));
	await writeFile(join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex'), '');
	process.env.PATH = bin;
	const realSpawn = Bun.spawn;
	let code = 4;
	Bun.spawn = ((options: Parameters<typeof Bun.spawn>[0]) =>
		realSpawn({
			...(options as object),
			cmd: [process.execPath, '-e', `process.exit(${code})`],
		} as never)) as typeof Bun.spawn;
	try {
		const failed = await queueRecorded('alpha', NONCE, 'fixture-thread', 'x').catch(
			(error: unknown) => error,
		);
		expect(failed).toBeInstanceOf(CodexQueueError);
		expect((failed as CodexQueueError).exitCode).toBe(4);
		code = 0;
		await rm(store(), { recursive: true });
		expect(await queueRecorded('alpha', NONCE, 'fixture-thread', 'x')).toBeUndefined();
		expect(await Bun.file(store()).exists()).toBe(false);
	} finally {
		Bun.spawn = realSpawn;
		await rm(bin, { recursive: true, force: true });
	}
});

test('own status shows the labels for a Codex seat and null otherwise', async () => {
	const status = (await scopedMail(['status'])) as { codexQueueFailures: unknown; nonce: string };
	expect(status.codexQueueFailures).toBeNull();
	await writeFile(
		join(fixture.records, 'alpha.json'),
		JSON.stringify(newRecord('alpha', fixture.root, 'codex')),
	);
	await recordQueueFailure(
		'alpha',
		status.nonce,
		new CodexQueueError('timeout', null, 'unclassified'),
	);
	expect(await scopedMail(['status'])).toMatchObject({
		codexQueueFailures: { retained: 1, latest: { outcome: 'timeout', exitCode: null } },
	});
});
