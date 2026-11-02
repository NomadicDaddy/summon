import { afterEach, beforeEach, expect, test } from 'bun:test';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TeamEvent } from '../src/desktop/types.ts';

import { initializeActivity } from '../src/agent-activity.ts';
import { Team } from '../src/desktop/team.ts';
import { stopTerminalReceivers, syncTerminalReceivers } from '../src/desktop/terminal-receivers.ts';
import { deliveryStatus, markReady, saveDelivery } from '../src/mail-session.ts';
import { startMailWatcher } from '../src/mail-watcher.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const originalHome = process.env.SUMMON_HOME;
const originalNonce = process.env.SUMMON_NONCE;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (originalHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = originalHome;
	if (originalNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = originalNonce;
	await fixture.dispose();
});

test('live delivery polling keeps file identity stable while a real state change updates it', async () => {
	const nonce = 'stable-live';
	const path = join(fixture.records, 'runtime/alpha', `${nonce}.json`);
	process.env.SUMMON_NONCE = nonce;
	const stop = await startMailWatcher('alpha', nonce, () => Promise.resolve());
	let stopped = false;
	try {
		await markReady('alpha', nonce);
		for (let i = 0; i < 80 && (await deliveryStatus('alpha', nonce)).state !== 'live'; i++)
			await Bun.sleep(100);
		expect((await deliveryStatus('alpha', nonce)).state).toBe('live');
		const before = await stat(path);
		await Bun.sleep(4300);
		const after = await stat(path);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		expect(after.ino).toBe(before.ino);
		await stop();
		stopped = true;
		expect((await deliveryStatus('alpha', nonce)).state).toBe('queued-only');
		expect((await stat(path)).mtimeMs).toBeGreaterThan(before.mtimeMs);
	} finally {
		if (!stopped) await stop();
	}
}, 15000);

test('a persistent receiver initialization failure reports once and recovery permits a new report', async () => {
	const events: TeamEvent[] = [];
	const team = new Team(
		'bun',
		'cli.ts',
		(event) => events.push(event),
		() => ({
			pid: process.pid,
			onData: () => ({ dispose: () => {} }),
			onExit: () => ({ dispose: () => {} }),
			write: () => {},
			resize: () => {},
			kill: () => {},
		}),
	);
	const activity = join(fixture.records, 'runtime/alpha/activity.json');
	try {
		await writeFile(
			join(fixture.records, 'alpha.json'),
			JSON.stringify(newRecord('alpha', fixture.root, 'grok')),
		);
		await team.start('alpha', false);
		await initializeActivity('alpha', 'recovered');
		const valid = await Bun.file(activity).text();
		await writeFile(activity, 'invalid json');
		await syncTerminalReceivers(team);
		await syncTerminalReceivers(team);
		expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
		await writeFile(activity, valid);
		await saveDelivery('alpha', {
			nonce: 'recovered',
			pid: process.pid,
			state: 'queued-only',
			reason: '',
			thread: 'disposable-thread',
		});
		await syncTerminalReceivers(team);
		await writeFile(activity, 'invalid again');
		await syncTerminalReceivers(team);
		await syncTerminalReceivers(team);
		expect(events.filter((event) => event.type === 'error')).toHaveLength(2);
	} finally {
		await stopTerminalReceivers(team);
	}
});
