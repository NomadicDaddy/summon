import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { LocalEvent } from '../src/local-room.ts';

import { telegramHarness, update } from './fixtures/telegram-harness.ts';

let fixture: Awaited<ReturnType<typeof telegramHarness>>;
beforeEach(async () => {
	fixture = await telegramHarness();
	await mkdir(join(fixture.root, 'room'));
	await writeFile(
		join(fixture.root, 'room/events.json'),
		JSON.stringify([
			{
				id: 1,
				at: new Date().toISOString(),
				sender: { kind: 'user', id: 'operator' },
				text: 'Desk question',
				replyTo: null,
				source: 'local',
			},
		]),
	);
});
afterEach(async () => {
	await fixture.dispose();
});
const history = async (): Promise<LocalEvent[]> => {
	const events: unknown = await Bun.file(join(fixture.root, 'room/events.json')).json();
	return events as LocalEvent[];
};
const reply = (id = '1', mode = 'success', text = 'Directed answer') =>
	fixture.invoke(['reply', '--to-user', id, text], mode, 'test-agent', '42', '--room');

test('desk reply keeps its local parent without sending a local id to Telegram', async () => {
	expect((await reply()).code).toBe(0);
	expect(await Bun.file(join(fixture.root, 'capture')).json()).not.toHaveProperty(
		'reply_parameters',
	);
	expect((await history()).at(-1)).toMatchObject({
		replyTo: 1,
		source: 'telegram:123:456:42',
		text: '📣 FOR YOU\n\nDirected answer',
	});
});

test('Telegram-origin room replies use the distinct Telegram parent and local parent', async () => {
	await writeFile(
		join(fixture.root, 'integrations/telegram.json'),
		JSON.stringify({
			botToken: '123:fake-test-token',
			chatId: '456',
			allowedUserIds: ['456'],
		}),
	);
	await writeFile(
		join(fixture.root, 'updates.json'),
		JSON.stringify([update(100, 'Phone question')]),
	);
	expect((await fixture.invoke(['sync'], 'success', '')).code).toBe(0);
	expect((await reply('2')).code).toBe(0);
	expect(await Bun.file(join(fixture.root, 'capture')).json()).toHaveProperty(
		'reply_parameters',
		{ message_id: 100 },
	);
	expect((await history()).at(-1)?.replyTo).toBe(2);
});

test('accepted reply survives failed mirror and repeated recovery without another send', async () => {
	const result = await reply('1', 'reply-mirror-failure');
	expect(result.code).toBe(1);
	expect(result.err).toContain('Do not resend');
	const path = join(fixture.root, 'room/events.json');
	await rm(path, { recursive: true });
	await rename(join(fixture.root, 'room/saved-events.json'), path);
	for (let attempt = 0; attempt < 2; attempt++) {
		expect((await fixture.invoke(['sync'], 'success', '')).code).toBe(0);
		expect(await history()).toHaveLength(2);
		expect((await history()).at(-1)?.replyTo).toBe(1);
		expect(await Bun.file(join(fixture.root, 'capture')).json()).not.toHaveProperty('text');
	}
});

test('invalid local reply targets and bodies never send', async () => {
	for (const id of ['0', '-1', '1e0', '999']) expect((await reply(id)).code).toBe(1);
	for (const text of [' ', 'x'.repeat(4096)])
		expect((await reply('1', 'success', text)).code).toBe(1);
	expect(await Bun.file(join(fixture.root, 'capture')).exists()).toBe(false);
});

test('directed local replies obey the communication pause', async () => {
	await mkdir(join(fixture.root, 'communications'));
	await writeFile(
		join(fixture.root, 'communications/state.json'),
		JSON.stringify({
			paused: true,
			changedAt: Date.now(),
			source: 'local',
			updates: {},
		}),
	);
	expect((await reply()).err).toContain('paused');
	expect(await history()).toHaveLength(1);
	expect(await Bun.file(join(fixture.root, 'capture')).json()).not.toHaveProperty('text');
});
