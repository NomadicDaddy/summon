import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { atomicWrite } from '../src/mail-files.ts';
import { readOwnChunk } from '../src/mail-read.ts';
import { sendMessage } from '../src/mailbox.ts';
import { relayResponseWatchdog } from '../src/response-watchdog-relay.ts';
import {
	dismissResponseEpisode,
	responseStatus,
	updateResponseState,
} from '../src/response-watchdog-store.ts';
import { evaluateResponseWatchdog } from '../src/response-watchdog.ts';
import { newRecord } from '../src/store.ts';
import { createWakeCoordinator } from '../src/wake-coordinator.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
};
let now = 1000000;
let wall: ReturnType<typeof spyOn<typeof Date, 'now'>>;
let monotonic: ReturnType<typeof spyOn<typeof performance, 'now'>>;
const nonce = 'relay-fixture';
const evaluate = () => evaluateResponseWatchdog('alpha', nonce);
const inbox = () => join(fixture.records, 'mailboxes/steward/inbox');
const relayPath = () => join(fixture.records, 'runtime/alpha/response-watchdog-relay.json');
const messages = async () =>
	Promise.all(
		(await readdir(inbox()).catch(() => []))
			.filter((p) => p.endsWith('.md'))
			.map((p) => readFile(join(inbox(), p), 'utf8')),
	);

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = nonce;
	await initializeActivity('alpha', nonce);
	now = 1000000;
	wall = spyOn(Date, 'now').mockImplementation(() => now);
	monotonic = spyOn(performance, 'now').mockImplementation(() => now);
	await atomicWrite(
		join(fixture.records, 'steward.json'),
		JSON.stringify({ ...newRecord('steward', fixture.root, 'codex'), memberType: 'pm' }),
	);
	await atomicWrite(join(fixture.records, `runtime/alpha/${nonce}.ready`), nonce);
});

afterEach(async () => {
	wall.mockRestore();
	monotonic.mockRestore();
	if (previous.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous.home;
	if (previous.agent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previous.agent;
	if (previous.nonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = previous.nonce;
	await fixture.dispose();
});

for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const) {
	test(`${provider} progress hides attention without duplicating or resolving its PM alert`, async () => {
		await atomicWrite(
			join(fixture.records, 'alpha.json'),
			JSON.stringify(newRecord('alpha', fixture.root, provider)),
		);
		const update = async (progress: number, clear = false) => {
			await updateResponseState('alpha', nonce, () =>
				Promise.resolve({
					observations: clear
						? []
						: [{ id: 'inventory', condition: 'inventory', progress }],
					targets: {},
					suspended: false,
				}),
			);
			await relayResponseWatchdog('alpha', nonce);
		};
		await update(0);
		now += 600000;
		await update(0);
		const episode = (await responseStatus('alpha', nonce))?.id;
		expect((await responseStatus('alpha', nonce))?.phase).toBe('attention');
		expect(await messages()).toHaveLength(1);
		now += 60000;
		await update(1);
		expect((await responseStatus('alpha', nonce))?.phase).toBe('observing');
		expect((await responseStatus('alpha', nonce))?.id).toBe(episode);
		expect(await messages()).toHaveLength(1);
		now += 600000;
		await update(1);
		expect((await responseStatus('alpha', nonce))?.phase).toBe('attention');
		expect(await messages()).toHaveLength(1);
		await update(1, true);
		expect(await messages()).toHaveLength(2);
		expect((await messages()).some((text) => text.includes('episode has resolved'))).toBe(true);
	});

	test(`${provider} watchdog relays one alert and exact-read resolution without retrying provider input`, async () => {
		await atomicWrite(
			join(fixture.records, 'alpha.json'),
			JSON.stringify(newRecord('alpha', fixture.root, provider)),
		);
		const id = await sendMessage('alpha', 'alpha', 'PRIVATE monitored body');
		let inputs = 0;
		const cycle = createWakeCoordinator(
			'alpha',
			nonce,
			() => {
				inputs++;
				return Promise.resolve();
			},
			() => true,
			() => Promise.resolve(true),
			{},
		);
		await cycle();
		expect(inputs).toBe(1);
		now += 600000;
		await cycle();
		await Promise.all([
			relayResponseWatchdog('alpha', nonce),
			relayResponseWatchdog('alpha', nonce),
		]);
		const alert = await messages();
		expect(alert).toHaveLength(1);
		expect(alert[0]).toContain('Delivered, awaiting read confirmation 10 min');
		expect(alert[0]).not.toContain('PRIVATE monitored body');
		now += 3600000;
		await cycle();
		expect(inputs).toBe(1);
		expect(await messages()).toHaveLength(1);
		await readOwnChunk('alpha', id, 0, 32768);
		await evaluate();
		await evaluate();
		expect(await messages()).toHaveLength(2);
		expect((await messages()).some((text) => text.includes('episode has resolved'))).toBe(true);
	});
}

test('archived publication survives a crash before journal acknowledgement and still resolves once', async () => {
	const id = await sendMessage('alpha', 'alpha', 'read later');
	await evaluate();
	now += 600000;
	await evaluate();
	const before = JSON.parse(await readFile(relayPath(), 'utf8')) as {
		recipients: { sent: boolean; alertId: string }[];
	};
	const recipient = before.recipients[0];
	if (!recipient) throw new Error('Missing recipient');
	const archive = join(fixture.records, 'mailboxes/steward/archive', `${recipient.alertId}.md`);
	await atomicWrite(archive, await readFile(join(inbox(), `${recipient.alertId}.md`), 'utf8'));
	await rename(join(inbox(), `${recipient.alertId}.md`), archive);
	for (const recipient of before.recipients) recipient.sent = false;
	await atomicWrite(relayPath(), JSON.stringify(before));
	await readOwnChunk('alpha', id, 0, 32768);
	await evaluate();
	await evaluate();
	expect(await messages()).toHaveLength(1);
	expect((await messages())[0]).toContain('episode has resolved');
});

test('halt queues resolution; dismissal does not resolve; replacement is not claimed as read', async () => {
	await sendMessage('alpha', 'alpha', 'read later');
	await evaluate();
	now += 600000;
	await evaluate();
	const state = await responseStatus('alpha', nonce);
	if (!state) throw new Error('Missing episode');
	await dismissResponseEpisode('alpha', nonce, state.id);
	await evaluate();
	expect(await messages()).toHaveLength(1);
	const pause = join(fixture.records, 'communications/state.json');
	await atomicWrite(
		pause,
		JSON.stringify({ paused: true, changedAt: now, source: 'test', updates: {} }),
	);
	await evaluateResponseWatchdog('alpha', 'replacement');
	expect(await messages()).toHaveLength(1);
	await atomicWrite(
		pause,
		JSON.stringify({ paused: false, changedAt: now, source: 'test', updates: {} }),
	);
	await evaluateResponseWatchdog('alpha', 'replacement');
	expect(await messages()).toHaveLength(2);
	expect((await messages()).some((text) => text.includes('not read confirmation'))).toBe(true);
});

test('Steward never self-escalates and a different named owner cannot relay', async () => {
	expect(
		await relayResponseWatchdog('beta', nonce).catch((error: unknown) => error),
	).toBeInstanceOf(Error);
	process.env.SUMMON_AGENT = 'steward';
	await initializeActivity('steward', nonce);
	await sendMessage('steward', 'steward', 'PM work');
	await evaluateResponseWatchdog('steward', nonce);
	now += 600000;
	await evaluateResponseWatchdog('steward', nonce);
	expect((await responseStatus('steward', nonce))?.phase).toBe('attention');
	expect(await messages()).toHaveLength(1);
});

test('replay refuses an existing ID with different content and never duplicates an archived message', async () => {
	const id = crypto.randomUUID();
	await sendMessage('alpha', 'steward', 'original', { id, replaySafe: true });
	expect(
		await sendMessage('alpha', 'steward', 'changed', { id, replaySafe: true }).catch(
			(error: unknown) => error,
		),
	).toBeInstanceOf(Error);
	await sendMessage('alpha', 'steward', 'original', { id, replaySafe: true });
	expect(await messages()).toHaveLength(1);
});

test('a new evaluator process retains the alert journal and does not resend after PM archival', async () => {
	await initializeActivity('alpha', 'reload-fixture');
	const run = async (time: number) => {
		const child = Bun.spawn({
			cmd: [
				process.execPath,
				join(import.meta.dir, 'fixtures/response-watchdog-reload.ts'),
				String(time),
			],
			env: { ...process.env, SUMMON_NONCE: 'reload-fixture' },
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
		});
		const [code, error] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
			new Response(child.stdout).text(),
		]);
		expect(code).toBe(0);
		expect(error).toBe('');
	};
	await run(1000000);
	await run(1600000);
	expect(await messages()).toHaveLength(1);
	const [file] = (await readdir(inbox())).filter((p) => p.endsWith('.md'));
	if (!file) throw new Error('Missing alert');
	const archived = join(fixture.records, 'mailboxes/steward/archive', file);
	await atomicWrite(archived, await readFile(join(inbox(), file), 'utf8'));
	await rename(join(inbox(), file), archived);
	await run(2000000);
	expect(await messages()).toHaveLength(0);
});

test('invalid relay state fails closed without inventing a new alert', async () => {
	await atomicWrite(relayPath(), '{broken');
	expect(await evaluate().catch((error: unknown) => error)).toBeInstanceOf(Error);
	expect(await messages()).toHaveLength(0);
});
