import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { communicationSend } from '../src/communication-gate.ts';
import { communicationState } from '../src/communication-state.ts';
import { isHibernated, setHibernation } from '../src/hibernation.ts';
import { startMailWatcher } from '../src/mail-watcher.ts';
import { roomCursorPath, roomDeliveryStatus } from '../src/telegram-live.ts';
import { recordRoomEvent } from '../src/telegram-room.ts';
import { syncTelegram } from '../src/telegram-sync.ts';
import { readRoom } from '../src/telegram.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { notifyRoom } from './fixtures/wake-notice.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const originalFetch = globalThis.fetch;
const originalRoot = process.env.SUMMON_HOME;
const originalAgent = process.env.SUMMON_AGENT;
const originalNonce = process.env.SUMMON_NONCE;
const config = { botToken: '123:test-token', chatId: '456', allowedUserIds: ['456'] };
let requests = 0;
let updates: unknown[] = [];
let stop: (() => Promise<void>) | undefined;

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = '';
	requests = 0;
	updates = [];
	await mkdir(join(fixture.records, 'integrations'));
	await writeFile(join(fixture.records, 'integrations/telegram.json'), JSON.stringify(config));
	globalThis.fetch = Object.assign(
		() => {
			requests++;
			return Promise.resolve(Response.json({ ok: true, result: updates }));
		},
		{ preconnect: originalFetch.preconnect },
	);
});
afterEach(async () => {
	await stop?.();
	stop = undefined;
	globalThis.fetch = originalFetch;
	if (originalRoot === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = originalRoot;
	if (originalAgent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = originalAgent;
	if (originalNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = originalNonce;
	await fixture.dispose();
});

function event(id: number, text: string) {
	return {
		update_id: id,
		message: {
			message_id: id,
			date: Math.floor(Date.now() / 1000),
			chat: { id: 456 },
			from: { id: 456, is_bot: false },
			text,
		},
	};
}
test('authenticated Telegram controls hibernate, reject bot releases and preserve newer local decisions', async () => {
	updates = [event(1, '@alpha --hibernate')];
	await syncTelegram(config);
	expect(await isHibernated('alpha')).toBe(true);
	const bot = event(2, '@alpha --unhibernate');
	bot.message.from.is_bot = true;
	updates = [bot, event(3, '@all --unhibernate'), event(4, '@_bad --hibernate')];
	await syncTelegram(config);
	expect(await isHibernated('alpha')).toBe(true);
	const stale = event(5, '@alpha --hibernate');
	await setHibernation('alpha', false);
	updates = [stale];
	await syncTelegram(config);
	expect(await isHibernated('alpha')).toBe(false);
});
async function eventually(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt++) {
		if (check()) return;
		await Bun.sleep(100);
	}
	throw new Error('Room notification did not arrive.');
}

function capture(notices: string[]): (text: string) => Promise<void> {
	return (text) => {
		notices.push(text);
		return Promise.resolve();
	};
}

test('contending receivers and reads finish while another poll is still in flight', async () => {
	const response = Promise.withResolvers<Response>();
	globalThis.fetch = Object.assign(
		() => {
			requests++;
			return response.promise;
		},
		{ preconnect: originalFetch.preconnect },
	);
	const polling = syncTelegram(config);
	try {
		await eventually(() => requests === 1);
		process.env.SUMMON_AGENT = 'alpha';
		process.env.SUMMON_NONCE = 'test-launch';
		await recordRoomEvent(config, {
			messageId: 2,
			text: 'already saved',
			sender: { kind: 'agent', id: 'beta' },
			replyTo: null,
		});
		const contenders = Promise.all([
			syncTelegram(config),
			syncTelegram(config, false, 2000),
			readRoom(config),
		]);
		const result = await Promise.race([
			contenders,
			Bun.sleep(1000).then(() => {
				throw new Error('Readers waited for the active poll');
			}),
		]);
		expect(result[0]).toBe(0);
		expect(result[1]).toBe(0);
		expect(result[2].events[0]?.text).toBe('already saved');
		expect(requests).toBe(1);
	} finally {
		response.resolve(Response.json({ ok: true, result: [] }));
		await polling;
	}
});

test('Telegram sending waits for the active poll and enforces its halt signal', async () => {
	const response = Promise.withResolvers<Response>();
	globalThis.fetch = Object.assign(
		() => {
			requests++;
			return requests === 1
				? response.promise
				: Promise.resolve(Response.json({ ok: true, result: [] }));
		},
		{ preconnect: originalFetch.preconnect },
	);
	const polling = syncTelegram(config);
	await eventually(() => requests === 1);
	let sent = false;
	let settled = false;
	const sending = communicationSend('send the Telegram message', () => {
		sent = true;
		return Promise.resolve();
	})
		.catch((error: unknown) => String(error))
		.finally(() => {
			settled = true;
		});
	try {
		await Bun.sleep(2800);
		expect(settled).toBe(false);
		expect(sent).toBe(false);
	} finally {
		response.resolve(Response.json({ ok: true, result: [event(1, 'halt')] }));
		await polling;
	}
	await sending;
	expect((await communicationState()).paused).toBe(true);
	expect(sent).toBe(false);
	expect(requests).toBe(2);
});

test('polling does not suppress failures from the operation inside its lock', async () => {
	globalThis.fetch = Object.assign(() => Promise.reject(new Error('Network unavailable')), {
		preconnect: originalFetch.preconnect,
	});
	expect(await syncTelegram(config).catch((error: unknown) => String(error))).toContain(
		'Telegram request could not be confirmed',
	);
	expect(await syncTelegram(config, true).catch((error: unknown) => String(error))).toContain(
		'Telegram request could not be confirmed',
	);
});

test('only an actual successful refresh clears the receiver outage signal', async () => {
	let successes = 0;
	const success = () => {
		successes++;
	};
	await syncTelegram(config, false, 2_000, false, success);
	expect({ requests, successes }).toEqual({ requests: 1, successes: 1 });
	await syncTelegram(config, false, 2_000, false, success);
	expect({ requests, successes }).toEqual({ requests: 1, successes: 1 });
	globalThis.fetch = Object.assign(() => Promise.reject(new Error('Network unavailable')), {
		preconnect: originalFetch.preconnect,
	});
	const failure = await syncTelegram(config, false, 0, false, success).catch(
		(error: unknown) => error,
	);
	expect(failure).toBeInstanceOf(Error);
	expect(successes).toBe(1);
	globalThis.fetch = Object.assign(
		() => {
			requests++;
			return Promise.resolve(Response.json({ ok: true, result: [] }));
		},
		{ preconnect: originalFetch.preconnect },
	);
	await syncTelegram(config, false, 0, false, success);
	expect(successes).toBe(2);
});

test('active receivers share polling, notify each teammate once, and require explicit read acknowledgement', async () => {
	updates = [event(1, 'private test context')];
	const alpha: string[] = [];
	const beta: string[] = [];
	await notifyRoom('alpha', 'launch-1', capture(alpha));
	await notifyRoom('beta', 'launch-2', capture(beta));
	expect(requests).toBe(1);
	expect(alpha).toHaveLength(1);
	expect(beta).toHaveLength(1);
	expect(alpha[0]).toContain('summon --checkpoint');
	expect(alpha[0]).toStartWith(
		'summon Telegram through 1 (read cursor); for you: seq 1 (summon --telegram read <seq-1>).',
	);
	expect(alpha[0]).not.toContain('private test context');
	expect(await roomDeliveryStatus(config, 'alpha', 'launch-1')).toContain(
		'reading is unconfirmed',
	);
	await notifyRoom('alpha', 'launch-1', capture(alpha));
	expect(alpha).toHaveLength(1);
	await writeFile(roomCursorPath(config, 'alpha'), '1');
	expect(await roomDeliveryStatus(config, 'alpha', 'launch-1')).toContain('reading acknowledged');
	await notifyRoom('alpha', 'new-launch', capture(alpha));
	expect(alpha).toHaveLength(1);
});

test('own posts do not wake their sender; addressed peer conversation does', async () => {
	await recordRoomEvent(config, {
		messageId: 1,
		text: 'my post',
		sender: { kind: 'agent', id: 'alpha' },
		replyTo: null,
	});
	const notices: string[] = [];
	await notifyRoom('alpha', 'launch-1', capture(notices));
	expect(notices).toEqual([]);
	await recordRoomEvent(config, {
		messageId: 2,
		text: '@alpha peer post',
		sender: { kind: 'agent', id: 'beta' },
		replyTo: null,
	});
	await notifyRoom('alpha', 'launch-1', capture(notices));
	expect(notices).toHaveLength(1);
	// The mention is the cause; the sender's own earlier post never is.
	expect(notices[0]).toStartWith(
		'summon Telegram through 2 (read cursor); for you: seq 2 (summon --telegram read <seq-1>).',
	);
});

test('uncertain delivery is not retried in a loop and durable history remains unread', async () => {
	updates = [event(1, 'hello')];
	let attempts = 0;
	const send = (): Promise<void> => {
		attempts++;
		return Promise.reject(new Error('Queue unavailable'));
	};
	await notifyRoom('alpha', 'launch-1', send);
	await notifyRoom('alpha', 'launch-1', send);
	expect(attempts).toBe(1);
	expect(await roomDeliveryStatus(config, 'alpha', 'launch-1')).toContain('failed');
	expect(await Bun.file(roomCursorPath(config, 'alpha')).exists()).toBe(false);
});

test('polling imports halt and proceed without sending any room message', async () => {
	updates = [event(1, 'halt')];
	await notifyRoom('alpha', 'launch-1', async () => {});
	expect((await communicationState()).paused).toBe(true);
	updates = [event(2, 'proceed')];
	await writeFile(join(fixture.records, 'integrations/telegram-state/123/polled-at'), '0');
	await notifyRoom('alpha', 'launch-1', async () => {});
	expect((await communicationState()).paused).toBe(false);
	expect(requests).toBe(2);
});

test('watcher delivers later events and stops polling on cleanup', async () => {
	const notices: string[] = [];
	stop = await startMailWatcher('alpha', 'launch-1', capture(notices));
	await eventually(() => requests === 1);
	updates = [event(1, 'arrived after startup')];
	await eventually(() => notices.some((text) => text.includes('summon Telegram through')));
	await stop();
	stop = undefined;
	const previous = requests;
	await Bun.sleep(2200);
	expect(requests).toBe(previous);
	expect(
		await readFile(
			join(fixture.records, 'integrations/telegram-state/123/456/events.json'),
			'utf8',
		),
	).toContain('arrived after startup');
}, 10000);
