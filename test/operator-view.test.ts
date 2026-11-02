import { afterEach, beforeEach, expect, test } from 'bun:test';

import { sendHuman } from '../src/local-room-access.ts';
import { optionalText } from '../src/mail-files.ts';
import { startMailWatcher } from '../src/mail-watcher.ts';
import { sendMessage } from '../src/mailbox.ts';
import { operatorViewing, saveOperatorView } from '../src/operator-view.ts';
import { localCursorPath } from '../src/room-cursor.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { notifyLocalRoom } from './fixtures/wake-notice.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const original = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (original === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = original;
	await fixture.dispose();
});

test('viewing follows selection and expires if the window stops renewing', async () => {
	expect(await operatorViewing('alpha')).toBe(false);
	const now = Date.now();
	await saveOperatorView('alpha', now);
	expect(await operatorViewing('alpha', now)).toBe(true);
	expect(await operatorViewing('beta', now)).toBe(false);
	expect(await operatorViewing('alpha', now + 6000)).toBe(false);
	await saveOperatorView('beta', now);
	expect(await operatorViewing('alpha', now)).toBe(false);
	expect(await operatorViewing('beta', now)).toBe(true);
	await saveOperatorView('', now);
	expect(await operatorViewing('beta', now)).toBe(false);
});

test('focused reading retains room messages without marking delivery or acknowledgement', async () => {
	await sendHuman('@alpha first');
	await saveOperatorView('alpha');
	const sent: string[] = [];
	const send = (text: string): Promise<void> => {
		sent.push(text);
		return Promise.resolve();
	};
	await notifyLocalRoom('alpha', 'fixture-view', send);
	await sendHuman('@alpha second');
	await notifyLocalRoom('alpha', 'fixture-view', send);
	expect(sent).toHaveLength(0);
	expect(await optionalText(localCursorPath('alpha'))).toBeUndefined();
	await saveOperatorView('');
	await notifyLocalRoom('alpha', 'fixture-view', send);
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain('through 2');
	await notifyLocalRoom('alpha', 'fixture-view', send);
	expect(sent).toHaveLength(1);
	expect(await optionalText(localCursorPath('alpha'))).toBeUndefined();
});

test('mail receiver retains new mail during viewing and delivers after release', async () => {
	await saveOperatorView('alpha');
	const sent: string[] = [];
	const stop = await startMailWatcher('alpha', 'fixture-view', (text) => {
		sent.push(text);
		return Promise.resolve();
	});
	try {
		await sendMessage('beta', 'alpha', 'work queued while being viewed');
		await Bun.sleep(2200);
		expect(sent).toHaveLength(0);
		await saveOperatorView('');
		for (let attempt = 0; attempt < 30 && sent.length === 0; attempt++) await Bun.sleep(100);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain('mailbox readiness');
		const pending = await fixture.run(['--mail', 'receive'], 'alpha');
		expect(pending.code).toBe(0);
		expect(pending.out).toContain('work queued while being viewed');
	} finally {
		await stop();
	}
}, 10000);
