import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { RestStopRefusedError } from '../src/rest-turn.ts';
import { readRest, stopForRest } from '../src/rest.ts';
import { providers, updateAgentRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { observedProviders, writeRestTurn } from './fixtures/rest-turn.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const original = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await initializeActivity('alpha', 'test-launch');
});
afterEach(async () => {
	if (original === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = original;
	await fixture.dispose();
});

async function ready(): Promise<string> {
	const result = await fixture.run(['--rest', 'ready'], 'alpha');
	expect(result.code).toBe(0);
	const state = await readRest('alpha');
	if (!state) throw new Error('Missing rest confirmation.');
	return state.id;
}

test.each(observedProviders)(
	'%s: busy, unknown and malformed turns refuse without stopping',
	async (provider) => {
		await updateAgentRecord('alpha', (record) => {
			record.provider = provider;
		});
		const id = await ready();
		let stops = 0;
		const stop = () => {
			stops++;
			return Promise.resolve();
		};
		for (const phase of ['busy', 'unknown'] as const) {
			await writeRestTurn(fixture.records, provider, 'alpha', 'test-launch', phase);
			const error: unknown = await stopForRest('alpha', id, stop, provider).catch(
				(value: unknown) => value,
			);
			expect(error).toBeInstanceOf(RestStopRefusedError);
			expect(String(error)).toContain(phase);
			expect(stops).toBe(0);
			expect((await readRest('alpha'))?.mode).toBe('ready');
		}
		await writeFile(
			join(fixture.records, `runtime/alpha/test-launch.${provider}-turn`),
			'{private-fixture',
		);
		const error: unknown = await stopForRest('alpha', id, stop, provider).catch(
			(value: unknown) => value,
		);
		expect(error).toBeInstanceOf(RestStopRefusedError);
		expect(String(error)).toContain('unknown or unreadable');
		expect(String(error)).not.toContain('private-fixture');
		expect(stops).toBe(0);
		expect((await readRest('alpha'))?.resume).toBe(false);
	},
);

test.each(providers.filter((provider) => provider !== 'codex'))(
	'%s: missing turn record retains explicit consent and activity policy',
	async (provider) => {
		await updateAgentRecord('alpha', (record) => {
			record.provider = provider;
		});
		const id = await ready();
		let received = '';
		await stopForRest(
			'alpha',
			id,
			(nonce) => {
				received = nonce;
				return Promise.resolve();
			},
			provider,
		);
		expect(received).toBe('test-launch');
		expect((await readRest('alpha'))?.mode).toBe('stopped');
	},
);

test('Codex without a bound native observation refuses even with ready consent', async () => {
	const id = await ready();
	let stopped = false;
	const failure: unknown = await stopForRest(
		'alpha',
		id,
		() => {
			stopped = true;
			return Promise.resolve();
		},
		'codex',
	).catch((error: unknown) => error);
	expect(String(failure)).toContain('unknown');
	expect(stopped).toBe(false);
	expect((await readRest('alpha'))?.mode).toBe('ready');
});

test('a busy record for an older launch does not become current turn evidence', async () => {
	const id = await ready();
	await writeRestTurn(fixture.records, 'claude', 'alpha', 'older-launch', 'busy');
	let stopped = false;
	await stopForRest(
		'alpha',
		id,
		() => {
			stopped = true;
			return Promise.resolve();
		},
		'claude',
	);
	expect(stopped).toBe(true);
});

test.each(observedProviders)(
	'%s: an unreadable current record refuses without invoking the stop',
	async (provider) => {
		const id = await ready();
		await mkdir(join(fixture.records, `runtime/alpha/test-launch.${provider}-turn`));
		let stopped = false;
		const failure: unknown = await stopForRest(
			'alpha',
			id,
			() => {
				stopped = true;
				return Promise.resolve();
			},
			provider,
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(RestStopRefusedError);
		expect(String(failure)).toContain('unknown or unreadable');
		expect(stopped).toBe(false);
		expect((await readRest('alpha'))?.mode).toBe('ready');
	},
);
