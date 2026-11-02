import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWrite } from '../src/mail-files.ts';
import { confirmMessage, readOwnChunk } from '../src/mail-read.ts';
import { sendMessage } from '../src/mailbox.ts';
import { responseStatus } from '../src/response-watchdog-store.ts';
import { evaluateResponseWatchdog, recordResponseAttempt } from '../src/response-watchdog.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
};
const nonce = 'recovery-fixture';
let now = 1000000;
let wall: ReturnType<typeof spyOn<typeof Date, 'now'>>;
let monotonic: ReturnType<typeof spyOn<typeof performance, 'now'>>;
const evaluate = () => evaluateResponseWatchdog('alpha', nonce);
const observationPath = () => join(fixture.records, 'runtime/alpha/response-watchdog.json');
const inbox = () => join(fixture.records, 'mailboxes/coordinator/inbox');
const messages = async () =>
	Promise.all(
		(await readdir(inbox()).catch(() => []))
			.filter((file) => file.endsWith('.md'))
			.map(async (file) => ({
				id: file.slice(0, -3),
				text: await readFile(join(inbox(), file), 'utf8'),
			})),
	);
const pause = (paused: boolean) =>
	atomicWrite(
		join(fixture.records, 'communications/state.json'),
		JSON.stringify({ paused, changedAt: now, source: 'test', updates: {} }),
	);

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = nonce;
	now = 1000000;
	wall = spyOn(Date, 'now').mockImplementation(() => now);
	monotonic = spyOn(performance, 'now').mockImplementation(() => now);
	await atomicWrite(
		join(fixture.records, 'coordinator.json'),
		JSON.stringify({ ...newRecord('coordinator', fixture.root, 'codex'), memberType: 'pm' }),
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

for (const damage of ['corrupt', 'missing'] as const) {
	test(`${damage} observation state never reports unresolved work as resolved`, async () => {
		await sendMessage('alpha', 'alpha', 'unread work');
		await evaluate();
		now += 600000;
		await evaluate();
		if (damage === 'corrupt') await atomicWrite(observationPath(), '{broken');
		else await unlink(observationPath());
		await evaluate();
		const mail = await messages();
		expect(mail).toHaveLength(2);
		expect(
			mail.some(({ text }) => text.includes('observation continuity ended or reset')),
		).toBe(true);
		expect(mail.some(({ text }) => text.includes('episode has resolved'))).toBe(false);
		expect((await responseStatus('alpha', nonce))?.expectations.length).toBeGreaterThan(0);
		expect(mail.every(({ text }) => !text.includes(nonce))).toBe(true);
	});
}

test('verified old cohort retirement resolves even with new unread work', async () => {
	const old = await sendMessage('alpha', 'alpha', 'old work');
	await evaluate();
	now += 600000;
	await evaluate();
	const episode = (await responseStatus('alpha', nonce))?.id;
	await readOwnChunk('alpha', old, 0, 32768);
	await sendMessage('alpha', 'alpha', 'new work');
	await evaluate();
	const state = await responseStatus('alpha', nonce);
	expect(state?.id).not.toBe(episode);
	expect(state?.retiredEpisodeId).toBe(episode);
	expect((await messages()).some(({ text }) => text.includes('episode has resolved'))).toBe(true);
	expect(state?.expectations.length).toBeGreaterThan(0);
});

test('PM confirmations and read receipts never generate a fresh watchdog episode', async () => {
	const work = await sendMessage('alpha', 'alpha', 'work');
	await evaluate();
	now += 600000;
	await evaluate();
	const [alert] = await messages();
	if (!alert) throw new Error('No alert');
	process.env.SUMMON_AGENT = 'coordinator';
	await readOwnChunk('coordinator', alert.id, 0, 32768);
	const confirmation = await confirmMessage('coordinator', alert.id, 'understood');
	process.env.SUMMON_AGENT = 'alpha';
	// Also cover transport targets retained by an earlier observer/attempt record.
	await recordResponseAttempt(
		'alpha',
		nonce,
		[{ source: 'mail', key: 'inbox', through: 0, ids: [confirmation] }],
		'awaiting-read',
		'a'.repeat(64),
	);
	await readOwnChunk('alpha', work, 0, 32768);
	await evaluate();
	const clear = (await messages()).find((mail) => mail.id !== alert.id);
	if (!clear) throw new Error('No clear');
	process.env.SUMMON_AGENT = 'coordinator';
	await readOwnChunk('coordinator', clear.id, 0, 32768);
	await confirmMessage('coordinator', clear.id, 'understood clear');
	process.env.SUMMON_AGENT = 'alpha';
	await evaluate();
	now += 600000;
	await evaluate();
	expect(await messages()).toHaveLength(2);
	expect((await responseStatus('alpha', nonce))?.phase).toBe('clear');
});

test('an episode entirely blocked by halt never publishes a stale alert and clear', async () => {
	const work = await sendMessage('alpha', 'alpha', 'work');
	await evaluate();
	await pause(true);
	now += 600000;
	await evaluate();
	expect(await messages()).toHaveLength(0);
	await readOwnChunk('alpha', work, 0, 32768);
	await evaluate();
	await pause(false);
	await evaluate();
	expect(await messages()).toHaveLength(0);
});
