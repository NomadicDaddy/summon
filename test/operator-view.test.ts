import { afterEach, beforeEach, expect, test } from 'bun:test';

import { sendHuman } from '../src/local-room-access.ts';
import { nextLocalRoomWakeAt, prepareLocalRoomNotice } from '../src/local-room-live.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { optionalText } from '../src/mail-files.ts';
import { startMailWatcher } from '../src/mail-watcher.ts';
import { sendMessage } from '../src/mailbox.ts';
import { operatorViewExpiry, operatorViewing, saveOperatorView } from '../src/operator-view.ts';
import { RECEIVER_FALLBACK_MS } from '../src/receiver-cadence.ts';
import { nextReceiverDeadline } from '../src/receiver-deadlines.ts';
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
	expect(await operatorViewExpiry('alpha', now)).toBe(now + 6000);
	expect(await nextReceiverDeadline('alpha', 'fixture-view', now)).toBe(now + 6000);
	expect(await nextReceiverDeadline('alpha', 'fixture-view', now + 6001, now)).toBe(now + 6000);
	expect(await operatorViewing('beta', now)).toBe(false);
	expect(await operatorViewing('alpha', now + 6000)).toBe(false);
	expect(await operatorViewExpiry('alpha', now + 6000)).toBeUndefined();
	await saveOperatorView('beta', now);
	expect(await operatorViewing('alpha', now)).toBe(false);
	expect(await operatorViewing('beta', now)).toBe(true);
	await saveOperatorView('', now);
	expect(await operatorViewing('beta', now)).toBe(false);
});

test('Room quiet deadline crossed during a receiver cycle remains armed', async () => {
	const previousAgent = process.env.SUMMON_AGENT;
	const previousNonce = process.env.SUMMON_NONCE;
	const previousQuiet = process.env.SUMMON_ROOM_WAKE_QUIET_MS;
	try {
		process.env.SUMMON_AGENT = 'alpha';
		process.env.SUMMON_NONCE = 'quiet-straddle';
		process.env.SUMMON_ROOM_WAKE_QUIET_MS = '5000';
		await appendLocalEvent({
			sender: { kind: 'user', id: 'operator' },
			text: '@alpha please check this',
			replyTo: null,
			source: 'local',
		});
		const cycleStartedAt = Date.now();
		expect(await prepareLocalRoomNotice('alpha', 'quiet-straddle')).toBeUndefined();
		const deadline = nextLocalRoomWakeAt(cycleStartedAt);
		expect(deadline).toBeDefined();
		if (deadline === undefined) throw new Error('Room quiet deadline was not retained.');
		expect(
			await nextReceiverDeadline('alpha', 'quiet-straddle', deadline + 1, cycleStartedAt),
		).toBe(deadline);
	} finally {
		if (previousAgent === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = previousAgent;
		if (previousNonce === undefined) delete process.env.SUMMON_NONCE;
		else process.env.SUMMON_NONCE = previousNonce;
		if (previousQuiet === undefined) delete process.env.SUMMON_ROOM_WAKE_QUIET_MS;
		else process.env.SUMMON_ROOM_WAKE_QUIET_MS = previousQuiet;
	}
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

test('receiver alarm delivers held mail when operator view expires before fallback', async () => {
	const receiverStartedAt = Date.now();
	const sent: string[] = [];
	let deliveredAt: number | undefined;
	let initialCollected: () => void = () => {};
	const startup = new Promise<void>((resolve) => {
		initialCollected = resolve;
	});
	const stop = await startMailWatcher(
		'alpha',
		'fixture-expiry',
		(text) => {
			deliveredAt = Date.now();
			sent.push(text);
			return Promise.resolve();
		},
		{
			noticeHold: () => {
				initialCollected();
				return Promise.resolve(undefined);
			},
		},
	);
	try {
		await Promise.race([
			startup,
			Bun.sleep(5000).then(() => {
				throw new Error('Initial receiver collection did not complete.');
			}),
		]);
		sent.length = 0;
		deliveredAt = undefined;
		await saveOperatorView('alpha');
		await sendMessage('beta', 'alpha', 'mail held until view expiry');
		const fallbackAt = receiverStartedAt + RECEIVER_FALLBACK_MS;
		expect(Date.now()).toBeLessThan(fallbackAt - 6500);
		await Bun.sleep(500);
		expect(sent).toHaveLength(0);
		while (sent.length === 0 && Date.now() < fallbackAt - 200) await Bun.sleep(50);
		expect(sent[0]).toContain('mailbox event');
		expect(deliveredAt).toBeLessThan(fallbackAt - 200);
	} finally {
		await stop();
	}
}, 12000);
