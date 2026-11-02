import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { stopTerminalReceivers, syncTerminalReceivers } from '../src/desktop/terminal-receivers.ts';
import {
	initializeKiloTurn,
	kiloStartupSettled,
	kiloStartupSubmitting,
	observeKiloTurn,
} from '../src/kilo-turn-state.ts';
import { saveDelivery } from '../src/mail-session.ts';
import * as mailWatcher from '../src/mail-watcher.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { terminalHarness } from './fixtures/owned-terminal.ts';
import { waitForNotice } from './fixtures/wake-team.ts';

/** A completed, observed startup turn, which Kilo readiness now waits for (Phillip #22057). */
async function startupCompleted(nonce: string, observer: string): Promise<void> {
	await kiloStartupSubmitting('alpha', nonce, 'disposable-thread');
	await kiloStartupSettled('alpha', nonce, 'disposable-thread', 'accepted');
	for (const type of ['busy', 'idle'])
		await observeKiloTurn('alpha', nonce, observer, {
			type: 'session.status',
			properties: { sessionID: 'disposable-thread', status: { type } },
		});
}

test('concurrent roster and mention scans share attachment and stop every owned watcher', async () => {
	const fixture = await mailHarness();
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = fixture.records;
	const h = terminalHarness();
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const original = mailWatcher.startMailWatcher;
	const starts: string[] = [];
	let oldStops = 0;
	const watcher = spyOn(mailWatcher, 'startMailWatcher').mockImplementation(
		async (name, nonce, send, options) => {
			starts.push(nonce);
			const stop = await original(name, nonce, send, options);
			return nonce === 'parallel-attachment'
				? async () => {
						oldStops++;
						await gate;
						await stop();
					}
				: stop;
		},
	);
	try {
		await Bun.write(
			join(fixture.records, 'alpha.json'),
			JSON.stringify(newRecord('alpha', fixture.root, 'kilo')),
		);
		await h.team.start('alpha', false);
		await initializeActivity('alpha', 'parallel-attachment');
		await initializeKiloTurn(
			'alpha',
			'parallel-attachment',
			'disposable-thread',
			'fixture-old',
		);
		await saveDelivery('alpha', {
			nonce: 'parallel-attachment',
			pid: process.pid,
			state: 'unconfirmed',
			reason: '',
			thread: 'disposable-thread',
		});
		await syncTerminalReceivers(h.team);
		await startupCompleted('parallel-attachment', 'fixture-old');
		await waitForNotice(h.inputs, 'parallel-attachment');
		await initializeActivity('alpha', 'replacement-attachment');
		await initializeKiloTurn(
			'alpha',
			'replacement-attachment',
			'disposable-thread',
			'fixture-new',
		);
		await saveDelivery('alpha', {
			nonce: 'replacement-attachment',
			pid: process.pid,
			state: 'unconfirmed',
			reason: '',
			thread: 'disposable-thread',
		});
		const first = syncTerminalReceivers(h.team);
		const second = syncTerminalReceivers(h.team);
		for (let attempt = 0; attempt < 100 && oldStops === 0; attempt++) await Bun.sleep(10);
		expect(oldStops).toBeGreaterThan(0);
		release();
		await Promise.all([first, second, h.team.syncHibernation()]);
		await startupCompleted('replacement-attachment', 'fixture-new');
		await waitForNotice(h.inputs, 'replacement-attachment');
		expect(starts).toEqual(['parallel-attachment', 'replacement-attachment']);
		expect(oldStops).toBe(1);
		expect(h.inputs).toHaveLength(2);
		await stopTerminalReceivers(h.team);
		expect(
			await Bun.file(join(fixture.records, 'runtime/alpha/receiver/owner.json')).exists(),
		).toBe(false);
		await Bun.sleep(2200);
		expect(h.inputs).toHaveLength(2);
	} finally {
		release();
		await stopTerminalReceivers(h.team);
		watcher.mockRestore();
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await fixture.dispose();
	}
});
