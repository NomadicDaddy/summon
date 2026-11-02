import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { saveHeadDown, sessionHeartbeat } from '../src/head-down-model.ts';
import { atomicWrite } from '../src/mail-files.ts';
import { readOwnChunk } from '../src/mail-read.ts';
import { acknowledgeMessage, sendMessage } from '../src/mailbox.ts';
import {
	dismissResponseEpisode,
	responseStatus,
	responseStatusView,
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
let clock: ReturnType<typeof spyOn<typeof Date, 'now'>>;
let monotonic: ReturnType<typeof spyOn<typeof performance, 'now'>>;
let now = 1000000;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = 'watchdog-fixture';
	now = 1000000;
	clock = spyOn(Date, 'now').mockImplementation(() => now);
	monotonic = spyOn(performance, 'now').mockImplementation(() => now);
	await atomicWrite(
		join(fixture.records, 'runtime/alpha/watchdog-fixture.ready'),
		'watchdog-fixture',
	);
});
afterEach(async () => {
	clock.mockRestore();
	monotonic.mockRestore();
	if (previous.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous.home;
	if (previous.agent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previous.agent;
	if (previous.nonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = previous.nonce;
	await fixture.dispose();
});

test('native gate does not hide unread work; timeout never invokes transport', async () => {
	await sendMessage('alpha', 'alpha', 'private fixture body');
	let sends = 0;
	const cycle = createWakeCoordinator(
		'alpha',
		'watchdog-fixture',
		() => {
			sends++;
			return Promise.resolve();
		},
		() => true,
		() => Promise.resolve(true),
		{ noticeAllowed: () => Promise.resolve(false) },
	);
	await cycle();
	now += 300000;
	await cycle();
	expect((await responseStatus('alpha', 'watchdog-fixture'))?.phase).toBe('waiting');
	now += 300000;
	await cycle();
	const alert = await responseStatus('alpha', 'watchdog-fixture');
	expect(alert?.phase).toBe('attention');
	expect(sends).toBe(0);
	expect(JSON.stringify(alert)).not.toContain('private fixture body');
	await cycle();
	expect((await responseStatus('alpha', 'watchdog-fixture'))?.id).toBe(alert?.id);
});

test('empty closed gate has no timer; exact read clears a submitted expectation', async () => {
	await evaluateResponseWatchdog('alpha', 'watchdog-fixture');
	expect((await responseStatus('alpha', 'watchdog-fixture'))?.phase).toBe('clear');
	const id = await sendMessage('alpha', 'alpha', 'read me');
	const cycle = createWakeCoordinator(
		'alpha',
		'watchdog-fixture',
		() => Promise.resolve(),
		() => true,
		() => Promise.resolve(true),
		{},
	);
	await cycle();
	const sent = await responseStatus('alpha', 'watchdog-fixture');
	expect(sent?.expectations.some((item) => item.condition === 'awaiting-read')).toBe(true);
	await readOwnChunk('alpha', id, 0, 32768);
	await evaluateResponseWatchdog('alpha', 'watchdog-fixture');
	expect((await responseStatus('alpha', 'watchdog-fixture'))?.phase).toBe('clear');
});

test('invalid checkpoint inventory alerts without sending and dismissal retains targets', async () => {
	await atomicWrite(join(fixture.records, 'runtime/alpha/checkpoint.json'), 'broken');
	await evaluateResponseWatchdog('alpha', 'watchdog-fixture');
	now += 600000;
	await evaluateResponseWatchdog('alpha', 'watchdog-fixture');
	const alert = await responseStatus('alpha', 'watchdog-fixture');
	expect(alert?.phase).toBe('attention');
	expect(alert?.expectations.some((item) => item.id === 'inventory:checkpoint')).toBe(true);
	if (!alert) throw new Error('Expected alert');
	await dismissResponseEpisode('alpha', 'watchdog-fixture', alert.id);
	now += 600000;
	await evaluateResponseWatchdog('alpha', 'watchdog-fixture');
	const dismissed = await responseStatus('alpha', 'watchdog-fixture');
	expect(dismissed?.phase).toBe('dismissed');
	expect(dismissed?.expectations.length).toBeGreaterThan(0);
	expect(dismissResponseEpisode('alpha', 'replacement', alert.id)).rejects.toThrow('changed');
});

test('corrupt state restarts with a visible diagnostic and a full observation window', async () => {
	await sendMessage('alpha', 'alpha', 'retained unread work');
	await atomicWrite(join(fixture.records, 'runtime/alpha/response-watchdog.json'), 'broken');
	const view = await responseStatusView('alpha', 'watchdog-fixture');
	expect(view.responseWatchdog).toBeNull();
	expect(view.responseWatchdogError).toContain('unavailable');
	await evaluateResponseWatchdog('alpha', 'watchdog-fixture');
	const state = await responseStatus('alpha', 'watchdog-fixture');
	expect(state?.diagnostic).toBe('state-reset');
	expect(state?.phase).toBe('observing');
	now += 600000;
	await evaluateResponseWatchdog('alpha', 'watchdog-fixture');
	expect((await responseStatus('alpha', 'watchdog-fixture'))?.phase).toBe('attention');
});

test('explicit archival retires pending work without creating read coverage', async () => {
	const id = await sendMessage('alpha', 'alpha', 'archive without claiming a read');
	await evaluateResponseWatchdog('alpha', 'watchdog-fixture');
	await acknowledgeMessage('alpha', id);
	now += 660000;
	await evaluateResponseWatchdog('alpha', 'watchdog-fixture');
	expect((await responseStatus('alpha', 'watchdog-fixture'))?.phase).toBe('clear');
	expect(
		await Bun.file(join(fixture.records, 'mailboxes/alpha/delivery', `${id}.read`)).exists(),
	).toBe(false);
});

test('halt at the deadline suspends; resumption retains identity and grants fresh time', async () => {
	await sendMessage('alpha', 'alpha', 'waiting');
	await evaluateResponseWatchdog('alpha', 'watchdog-fixture');
	const first = await responseStatus('alpha', 'watchdog-fixture');
	const file = join(fixture.records, 'communications/state.json');
	await atomicWrite(
		file,
		JSON.stringify({ paused: true, changedAt: now, source: 'fixture', updates: {} }),
	);
	now += 600000;
	await evaluateResponseWatchdog('alpha', 'watchdog-fixture');
	expect((await responseStatus('alpha', 'watchdog-fixture'))?.phase).toBe('suspended');
	await atomicWrite(
		file,
		JSON.stringify({ paused: false, changedAt: now, source: 'fixture', updates: {} }),
	);
	await evaluateResponseWatchdog('alpha', 'watchdog-fixture');
	const resumed = await responseStatus('alpha', 'watchdog-fixture');
	expect(resumed?.id).toBe(first?.id);
	expect(resumed?.phase).toBe('observing');
	now += 599999;
	await evaluateResponseWatchdog('alpha', 'watchdog-fixture');
	expect((await responseStatus('alpha', 'watchdog-fixture'))?.phase).toBe('waiting');
});

for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const) {
	test(`${provider} fixture: timeout does not resend; complete read resolves the alert`, async () => {
		await atomicWrite(
			join(fixture.records, 'alpha.json'),
			JSON.stringify(newRecord('alpha', fixture.root, provider)),
		);
		const id = await sendMessage('alpha', 'alpha', 'fixture');
		let sent = 0;
		const cycle = createWakeCoordinator(
			'alpha',
			'watchdog-fixture',
			() => {
				sent++;
				return Promise.resolve();
			},
			() => true,
			() => Promise.resolve(true),
			{},
		);
		await cycle();
		expect(sent).toBe(1);
		now += 600000;
		await cycle();
		const state = await responseStatus('alpha', 'watchdog-fixture');
		expect(state?.phase).toBe('attention');
		expect(Object.keys(state?.outcomes ?? {})).toHaveLength(1);
		expect(sent).toBe(1);
		await readOwnChunk('alpha', id, 0, 32768);
		await cycle();
		expect((await responseStatus('alpha', 'watchdog-fixture'))?.phase).toBe('clear');
	});
}

for (const exemption of ['hibernation', 'head-down'] as const) {
	test(`${exemption} suspends the deadline without consuming read coverage`, async () => {
		await sendMessage('alpha', 'alpha', 'waiting');
		await evaluateResponseWatchdog('alpha', 'watchdog-fixture');
		await initializeActivity('alpha', 'watchdog-fixture');
		if (exemption === 'hibernation') {
			const record = newRecord('alpha', fixture.root, 'claude');
			record.hibernation = {
				active: true,
				revision: '11111111-1111-4111-8111-111111111111',
				changedAt: now,
			};
			await atomicWrite(join(fixture.records, 'alpha.json'), JSON.stringify(record));
		} else {
			await saveHeadDown('alpha', {
				id: '11111111-1111-4111-8111-111111111111',
				nonce: 'watchdog-fixture',
				phase: 'active',
				goal: 'fixture',
				completion: 'fixture',
				questionId: 1,
				approvedBy: 'operator',
			});
			await sessionHeartbeat('alpha', 'watchdog-fixture');
		}
		now += 600000;
		await evaluateResponseWatchdog('alpha', 'watchdog-fixture');
		const state = await responseStatus('alpha', 'watchdog-fixture');
		expect(state?.phase).toBe('suspended');
		expect(state?.expectations).toHaveLength(1);
		expect(state?.alerted).toBe(false);
	});
}

test('stopped receiver does not evaluate; replacement nonce starts a new observation window', async () => {
	await sendMessage('alpha', 'alpha', 'waiting');
	await evaluateResponseWatchdog('alpha', 'watchdog-fixture');
	const first = await responseStatus('alpha', 'watchdog-fixture');
	const cycle = createWakeCoordinator(
		'alpha',
		'watchdog-fixture',
		() => Promise.resolve(),
		() => false,
		() => Promise.resolve(true),
		{},
	);
	now += 600000;
	await cycle();
	expect((await responseStatus('alpha', 'watchdog-fixture'))?.alerted).toBe(false);
	await evaluateResponseWatchdog('alpha', 'replacement');
	const replacement = await responseStatus('alpha', 'replacement');
	expect(replacement?.id).not.toBe(first?.id);
	expect(replacement?.phase).toBe('observing');
	expect(await responseStatus('alpha', 'watchdog-fixture')).toBeNull();
});

test('failed response retention prevents input and preserves definite-unsent backoff', async () => {
	await sendMessage('alpha', 'alpha', 'retained work');
	await mkdir(join(fixture.records, 'runtime/alpha/response-watchdog.json'));
	let sends = 0;
	const cycle = createWakeCoordinator(
		'alpha',
		'watchdog-fixture',
		() => {
			sends++;
			return Promise.resolve();
		},
		() => true,
		() => Promise.resolve(true),
		{},
	);
	await cycle();
	await cycle();
	expect(sends).toBe(0);
	await rmdir(join(fixture.records, 'runtime/alpha/response-watchdog.json'));
	now += 2000;
	await cycle();
	expect(sends).toBe(1);
});
