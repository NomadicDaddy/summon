import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { communicationState } from '../src/communication-state.ts';
import { sendHuman } from '../src/local-room-access.ts';
import {
	cachedLocalEvents,
	localEvents,
	localPage,
	localRoomPath,
	localTail,
} from '../src/local-room.ts';
import { runtimePath } from '../src/mail-session.ts';
import { NotificationNotSentError } from '../src/notification-delivery.ts';
import { roomCache } from '../src/room-cache.ts';
import { recordRoomEvent } from '../src/telegram-room.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { notifyLocalRoom } from './fixtures/wake-notice.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const originalRoot = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (originalRoot === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = originalRoot;
	await fixture.dispose();
});

test('room tail bounds startup history and receiver cache invalidates after append', async () => {
	await mkdir(join(fixture.records, 'room'), { recursive: true });
	await writeFile(
		localRoomPath(),
		JSON.stringify(
			Array.from({ length: 305 }, (_, index) => ({
				id: index + 1,
				at: new Date().toISOString(),
				sender: { kind: 'user', id: 'operator' },
				text: `Message ${index}`,
				replyTo: null,
				source: 'local',
			})),
		),
	);
	expect(await localTail(300)).toBe(5);
	expect(await localTail(500)).toBe(0);
	expect(await localTail(0)).toBe(305);
	const cached = roomCache<Awaited<ReturnType<typeof localEvents>>>();
	let reads = 0;
	const read = () => {
		reads++;
		return localEvents();
	};
	expect(await cached(localRoomPath(), read)).toHaveLength(305);
	expect(await cached(localRoomPath(), read)).toHaveLength(305);
	expect(reads).toBe(1);
	await sendHuman('New message');
	expect(await cached(localRoomPath(), read)).toHaveLength(306);
	expect(reads).toBe(2);
	expect(await localTail(300)).toBe(6);
});

test('shared read cache serves pages, invalidates external writes, and stays separate from writers', async () => {
	await sendHuman('First');
	const first = await cachedLocalEvents();
	expect(await cachedLocalEvents()).toBe(first);
	expect((await localPage(0)).events[0]).toBe(first[0]);
	await sendHuman('Second');
	expect(first).toHaveLength(1);
	const second = await cachedLocalEvents();
	expect(second).not.toBe(first);
	expect(second).toHaveLength(2);
	await writeFile(localRoomPath(), JSON.stringify([{ ...second[0], text: 'External' }]));
	expect((await cachedLocalEvents())[0]?.text).toBe('External');
	await writeFile(localRoomPath(), 'invalid history');
	expect(await cachedLocalEvents().catch(String)).toContain('SyntaxError');
});

test('local user and two agents share durable replies, pages and independent cursors', async () => {
	await sendHuman('Who is ready?');
	const replies = await Promise.all(
		['alpha', 'beta'].map((name) =>
			fixture.run(['--room', 'reply', '1', `${name} ready`], name),
		),
	);
	expect(replies.every((result) => result.code === 0)).toBe(true);
	expect((await localEvents()).map((event) => event.id)).toEqual([1, 2, 3]);
	expect((await localEvents()).slice(1).every((event) => event.replyTo === 1)).toBe(true);
	expect((await fixture.run(['--room', 'ack', '3'], 'alpha')).code).toBe(0);
	const alphaPage = JSON.parse((await fixture.run(['--room', 'read'], 'alpha')).out) as Awaited<
		ReturnType<typeof localPage>
	>;
	const betaPage = JSON.parse((await fixture.run(['--room', 'read'], 'beta')).out) as Awaited<
		ReturnType<typeof localPage>
	>;
	expect(alphaPage.events).toHaveLength(0);
	expect(betaPage.events).toHaveLength(3);
	expect((await fixture.run(['--room', 'ack', '4'], 'alpha')).code).toBe(1);
	expect((await fixture.run(['--room', 'send', 'fake human'])).code).toBe(1);
	expect((await fixture.run(['--room', 'reply', '999', 'bad'], 'alpha')).code).toBe(1);
	for (let index = 0; index < 21; index++) await sendHuman(`page ${index}`);
	const first = await localPage(0);
	expect(first.more).toBe(true);
	expect((await localPage(first.nextCursor)).events).toHaveLength(4);
});

test('room pages bound UTF-8 bytes and cursor input rejects alternate number formats', async () => {
	for (let index = 0; index < 4; index++) await sendHuman('界'.repeat(4096));
	const page = await localPage(0);
	expect(page.events).toHaveLength(2);
	expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThan(28000);
	expect(page.more).toBe(true);
	for (const cursor of ['', '0x10', '1e1', '-1', 'NaN']) {
		expect((await fixture.run(['--room', 'read', cursor], 'alpha')).code).toBe(1);
		expect((await fixture.run(['--room', 'ack', cursor], 'alpha')).code).toBe(1);
	}
});

test('human halt applies to local agents; peer proceed cannot clear it', async () => {
	await sendHuman(' HALT ');
	expect((await communicationState()).paused).toBe(true);
	expect((await fixture.run(['--room', 'send', 'proceed'], 'alpha')).code).toBe(1);
	expect((await fixture.run(['--room', 'read'], 'alpha')).code).toBe(0);
	expect((await fixture.run(['--comms', 'proceed'], 'alpha')).code).toBe(1);
	await sendHuman('still paused');
	expect((await communicationState()).paused).toBe(true);
	await sendHuman('proceed');
	expect((await fixture.run(['--room', 'send', 'resumed'], 'alpha')).code).toBe(0);
});

test('local notices skip own posts, do not loop, and catch up after restart', async () => {
	await fixture.run(['--room', 'send', 'own'], 'alpha');
	const notices: string[] = [];
	const send = (text: string): Promise<void> => {
		notices.push(text);
		return Promise.resolve();
	};
	await notifyLocalRoom('alpha', 'launch-one', send);
	expect(notices).toHaveLength(0);
	await sendHuman('please read');
	await notifyLocalRoom('alpha', 'launch-one', send);
	await notifyLocalRoom('alpha', 'launch-one', send);
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain('summon --checkpoint');
	await notifyLocalRoom('alpha', 'launch-two', send);
	expect(notices).toHaveLength(2);
	await fixture.run(['--room', 'ack', '2'], 'alpha');
	await notifyLocalRoom('alpha', 'launch-three', send);
	expect(notices).toHaveLength(2);
});

test('definite pre-send local failure stays unread and retries on the next poll', async () => {
	await sendHuman('please read this');
	const path = join(runtimePath('alpha'), 'retry-room.notice');
	let failure: unknown;
	try {
		await notifyLocalRoom('alpha', 'retry', () =>
			Promise.reject(new NotificationNotSentError('provider unavailable')),
		);
	} catch (error: unknown) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(NotificationNotSentError);
	expect((failure as Error).message).not.toContain('provider unavailable');
	expect(JSON.parse(await Bun.file(path).text())).toEqual({ through: 1, state: 'deferred' });

	const notices: string[] = [];
	await Bun.sleep(2100);
	await notifyLocalRoom('alpha', 'retry', (text) => {
		notices.push(text);
		return Promise.resolve();
	});
	expect(notices).toHaveLength(1);
	expect(JSON.parse(await Bun.file(path).text())).toEqual({ through: 1, state: 'queued' });
});

test('uncertain local integer cursor avoids a retry loop and refreshes for a new human', async () => {
	await sendHuman('delivery status is unknown');
	const root = runtimePath('alpha');
	await mkdir(root, { recursive: true });
	const path = join(root, 'legacy-room.notice');
	await writeFile(path, '1');
	const notices: string[] = [];
	const send = (text: string): Promise<void> => {
		notices.push(text);
		return Promise.resolve();
	};

	await notifyLocalRoom('alpha', 'legacy', send);
	expect(notices).toHaveLength(0);
	expect(await Bun.file(path).text()).toBe('1');

	await sendHuman('new message');
	await notifyLocalRoom('alpha', 'legacy', send);
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain('through 2');
	expect(JSON.parse(await Bun.file(path).text())).toEqual({ through: 2, state: 'queued' });
});

test('Telegram bridge deduplicates replay and preserves user identity and reply context', async () => {
	const config = { botToken: '123:fake', chatId: '456', allowedUserIds: ['456'] };
	const event = {
		messageId: 10,
		sender: { kind: 'agent' as const, id: 'alpha' },
		text: 'Attention',
		replyTo: null,
	};
	await recordRoomEvent(config, event);
	await recordRoomEvent(config, event);
	await recordRoomEvent(config, {
		messageId: 11,
		sender: { kind: 'user', id: '456' },
		text: 'Yes',
		replyTo: 10,
	});
	const history = await localEvents();
	expect(history).toHaveLength(2);
	expect(history[1]?.replyTo).toBe(1);
	expect(history[1]?.sender).toEqual({ kind: 'user', id: '456' });
	const notices: string[] = [];
	await notifyLocalRoom('beta', 'launch-one', (text) => {
		notices.push(text);
		return Promise.resolve();
	});
	expect(notices).toHaveLength(0);
});
