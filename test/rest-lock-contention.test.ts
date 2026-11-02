import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { tickRest } from '../src/desktop/rest.ts';
import { Team } from '../src/desktop/team.ts';
import { locked, optionalText } from '../src/mail-files.ts';
import { readRest, refreshRest, restCommand, restSuppressed } from '../src/rest.ts';
import { loadAgent, saveAgent } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
};
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await initializeActivity('alpha', 'test-launch');
});
afterEach(async () => {
	if (previous.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous.home;
	if (previous.agent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previous.agent;
	if (previous.nonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = previous.nonce;
	await fixture.dispose();
});

test('roster observes a committed confirmation during contention; wakes wait without uncertainty', async () => {
	expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
	const saved = await readRest('alpha');
	const events: unknown[] = [];
	const team = new Team(
		'bun',
		'cli.ts',
		(event) => events.push(event),
		() => {
			throw new Error('No contention test may start a provider');
		},
	);
	await locked(join(fixture.records, 'runtime/alpha/rest.json.lock'), async () => {
		const [snapshot, tick, suppression] = await Promise.allSettled([
			team.snapshot(),
			tickRest(team),
			restSuppressed('alpha'),
		]);
		expect(snapshot.status).toBe('fulfilled');
		if (snapshot.status !== 'fulfilled') throw snapshot.reason;
		expect(
			snapshot.value.agents.find((agent) => agent.slug === 'alpha')?.restConfirmation,
		).toBe(saved?.id);
		expect(tick.status).toBe('fulfilled');
		expect(suppression).toEqual({ status: 'fulfilled', value: true });
		expect(events).toHaveLength(0);
		expect(await readRest('alpha')).toEqual(saved);
	});
	expect((await refreshRest('alpha'))?.id).toBe(saved?.id);
}, 15000);

test('readiness with a configured PM and Telegram stays local and releases its lock', async () => {
	const pm = await loadAgent('beta');
	if (!pm) throw new Error('Missing fixture PM');
	pm.memberType = 'pm';
	await saveAgent('beta', pm);
	await mkdir(join(fixture.records, 'integrations'));
	await writeFile(
		join(fixture.records, 'integrations/telegram.json'),
		JSON.stringify({
			botToken: '123:fixture',
			chatId: '1',
		}),
	);
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = 'test-launch';
	const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(() => Promise.resolve(Response.json({ ok: true, result: [] })), {
			preconnect: globalThis.fetch.preconnect,
		}),
	);
	try {
		await restCommand(['ready']);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(
			await optionalText(join(fixture.records, 'runtime/alpha/rest.json.lock')),
		).toBeUndefined();
		expect((await readRest('alpha'))?.mode).toBe('ready');
	} finally {
		fetchMock.mockRestore();
	}
});

test('an in-flight first confirmation suppresses notices before rest.json exists', async () => {
	expect(await readRest('alpha')).toBeUndefined();
	await locked(join(fixture.records, 'runtime/alpha/rest.json.lock'), async () => {
		expect(await restSuppressed('alpha')).toBe(true);
	});
	expect(await refreshRest('alpha')).toBeUndefined();
	expect(await restSuppressed('alpha')).toBe(false);
}, 15000);

test('absent and cancelled rest states do not acquire poll locks', async () => {
	const links = spyOn(fs, 'link');
	try {
		expect(await refreshRest('alpha')).toBeUndefined();
		expect(links).not.toHaveBeenCalled();
		expect((await fixture.run(['--rest', 'ready'], 'alpha')).code).toBe(0);
		expect((await fixture.run(['--rest', 'cancel'], 'alpha')).code).toBe(0);
		links.mockClear();
		expect((await refreshRest('alpha'))?.mode).toBe('awake');
		expect(links).not.toHaveBeenCalled();
	} finally {
		links.mockRestore();
	}
});
