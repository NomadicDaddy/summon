import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { setCommunicationPause } from '../src/communication-state.ts';
import { deliverHibernationControl, setHibernation } from '../src/hibernation.ts';
import { sendHuman } from '../src/local-room-access.ts';
import { optionalText } from '../src/mail-files.ts';
import { startMailWatcher } from '../src/mail-watcher.ts';
import { sendMessage } from '../src/mailbox.ts';
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

async function eventually(check: () => boolean): Promise<void> {
	for (let i = 0; i < 80; i++) {
		if (check()) return;
		await Bun.sleep(100);
	}
	throw new Error('Expected resumed notification was not delivered.');
}

test('shared watcher retains halted mail and local room notices until proceed', async () => {
	await sendMessage('alpha', 'beta', 'unread while halted');
	await sendHuman('@beta room while halted');
	await setCommunicationPause(true);
	process.env.SUMMON_AGENT = 'beta';
	process.env.SUMMON_NONCE = 'halt-fixture';
	const sent: string[] = [];
	const stop = await startMailWatcher('beta', 'halt-fixture', (text) => {
		sent.push(text);
		return Promise.resolve();
	});
	try {
		await Bun.sleep(2500);
		expect(sent).toEqual([]);
		expect(
			await optionalText(join(fixture.records, 'runtime/beta/halt-fixture.attempts')),
		).toBeUndefined();
		expect((await fixture.run(['--comms', 'proceed'])).code).toBe(0);
		await eventually(() => sent.some((text) => text.includes('mailbox readiness')));
		await eventually(() => sent.some((text) => text.includes('summon room')));
	} finally {
		await stop();
	}
}, 15000);

test('halted hibernation control retains its revision and sends once after proceed', async () => {
	await setHibernation('alpha', true);
	await setCommunicationPause(true);
	const sent: string[] = [];
	const send = (text: string): Promise<void> => {
		sent.push(text);
		return Promise.resolve();
	};
	const failure: unknown = await deliverHibernationControl('alpha', 'halt-control', send).catch(
		(error: unknown) => error,
	);
	expect(failure).toBeInstanceOf(Error);
	if (!(failure instanceof Error)) throw new Error('Expected halted control failure.');
	expect(failure.message).toContain('Halt');
	expect(sent).toEqual([]);
	expect(
		await optionalText(join(fixture.records, 'runtime/alpha/halt-control.hibernation-control')),
	).toBeUndefined();
	await setCommunicationPause(false);
	expect(await deliverHibernationControl('alpha', 'halt-control', send)).toBe(true);
	expect(await deliverHibernationControl('alpha', 'halt-control', send)).toBe(true);
	expect(sent).toHaveLength(1);
});
