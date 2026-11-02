import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { readRest, stopForRest } from '../src/rest.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await initializeActivity('alpha', 'test-launch');
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

async function status() {
	const result = await fixture.run(['--rest', 'status'], 'alpha');
	expect(result.code).toBe(0);
	return JSON.parse(result.out) as unknown;
}

for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const) {
	test(`${provider}: old confirmation is visibly historical and cannot stop the new launch`, async () => {
		await writeFile(
			join(fixture.records, 'alpha.json'),
			JSON.stringify(newRecord('alpha', fixture.root, provider)),
		);
		expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
		const original = await readRest('alpha');
		if (!original) throw new Error('Missing fixture confirmation');
		expect(await status()).toMatchObject({
			mode: 'ready',
			nonce: 'test-launch',
			currentLaunchNonce: 'test-launch',
			confirmationIsCurrentLaunch: true,
		});
		await initializeActivity('alpha', 'new-launch');
		// The old caller's environment must not override the recorded new launch.
		expect(await status()).toMatchObject({
			id: original.id,
			mode: 'awake',
			nonce: 'test-launch',
			currentLaunchNonce: 'new-launch',
			confirmationIsCurrentLaunch: false,
			resume: false,
		});
		const retained = await fixture.read('runtime/alpha/rest.json');
		await status();
		expect(await fixture.read('runtime/alpha/rest.json')).toBe(retained);
		let stopped = false;
		const result: unknown = await stopForRest(
			'alpha',
			original.id,
			() => {
				stopped = true;
				return Promise.resolve();
			},
			provider,
		).catch((error: unknown) => error);
		expect(result).toBeInstanceOf(Error);
		if (!(result instanceof Error)) throw new Error('Expected stale confirmation failure');
		expect(result.message).toContain('Rest confirmation changed');
		expect(stopped).toBe(false);
		expect(await readFile(fixture.capture, 'utf8')).toBe('');
	});
}

test('matching launch after cancel is not reported ready; absent activity stays unknown', async () => {
	expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
	expect((await fixture.run(['--rest', 'cancel'], 'alpha')).code).toBe(0);
	expect(await status()).toMatchObject({ mode: 'awake', confirmationIsCurrentLaunch: true });
	await rm(join(fixture.records, 'runtime/alpha/activity.json'));
	expect(await status()).toMatchObject({
		mode: 'awake',
		nonce: 'test-launch',
		currentLaunchNonce: null,
		confirmationIsCurrentLaunch: null,
	});
});

test('no confirmation remains null', async () => {
	expect(await status()).toBeNull();
});
