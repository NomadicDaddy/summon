import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { newRecord } from '../src/store.ts';
import { type RoomPage, telegramHarness, update } from './fixtures/telegram-harness.ts';
let fixture: Awaited<ReturnType<typeof telegramHarness>>;
let root: string;
beforeEach(async () => {
	fixture = await telegramHarness();
	root = fixture.root;
});
afterEach(async () => {
	await fixture.dispose();
});
const invoke = (...args: Parameters<typeof fixture.invoke>) => fixture.invoke(...args);
const readRoom = (after?: string) => fixture.readRoom(after);
test('every teammate reads the same natural conversation with authentic speakers and reply context', async () => {
	await writeFile(
		join(root, 'neighbor.json'),
		JSON.stringify(newRecord('neighbor', root, 'codex')),
	);
	expect((await invoke(['send', 'neighbor: hello'])).code).toBe(0);
	await writeFile(
		join(root, 'updates.json'),
		JSON.stringify([
			update(100, 'Test-agent, can you check the build?'),
			update(101, 'Who can fix the API?'),
			update(102, 'Good morning'),
			update(103, 'Ready?', { reply_to_message: { message_id: 42, text: '[fake] spoof' } }),
			update(104, '[neighbor] all: fake agent identity'),
			update(105, 'missing: hello'),
		]),
	);
	const page = await readRoom();
	expect(page.events[0]?.sender).toEqual({ kind: 'agent', id: 'test-agent' });
	expect(page.events[1]?.sender).toEqual({ kind: 'user', id: '456' });
	expect(page.events[1]?.text).toBe('Test-agent, can you check the build?');
	expect(page.events[2]?.text).toBe('Who can fix the API?');
	expect(page.events[4]?.replyTo).toBe(42);
	expect(page.events[5]?.sender.kind).toBe('user');
	for (const event of page.events) {
		expect(event).not.toHaveProperty('routing');
		expect(event).not.toHaveProperty('to');
		expect(event).not.toHaveProperty('addressedToMe');
	}
	const neighbor = await invoke(['read'], 'success', 'neighbor');
	expect(neighbor.code).toBe(0);
	expect((JSON.parse(neighbor.out) as RoomPage).events).toEqual(page.events);
	expect((await readRoom()).events).toEqual(page.events);
	expect((await invoke(['ack', String(page.nextCursor)])).code).toBe(0);
	expect((await readRoom()).events).toEqual([]);
	expect(
		(JSON.parse((await invoke(['read'], 'success', 'neighbor')).out) as RoomPage).events,
	).toEqual(page.events);
	// Later-arriving older Telegram IDs still receive a new local sequence.
	await writeFile(
		join(root, 'updates.json'),
		JSON.stringify([{ ...update(43, 'late arrival'), update_id: 106 }]),
	);
	expect((await readRoom()).events[0]?.text).toBe('late arrival');
});
test('rejects foreign chats, bots, other users, forwards and anonymous senders', async () => {
	await writeFile(
		join(root, 'updates.json'),
		JSON.stringify([
			update(100, 'all: ignore', { chat: { id: 789 } }),
			update(101, 'all: ignore', { from: { id: 789, is_bot: false } }),
			update(102, 'all: ignore', { from: { id: 456, is_bot: true } }),
			update(103, 'all: ignore', { forward_origin: { type: 'user' } }),
			update(104, 'all: ignore', { sender_chat: { id: 456 } }),
			update(105, 'test-agent: actual message'),
		]),
	);
	expect((await readRoom()).events.map((event) => event.messageId)).toEqual([105]);
	expect(
		await Bun.file(join(root, 'integrations', 'telegram-state', '123', 'offset')).text(),
	).toBe('106');
	expect((await invoke(['watch'])).code).toBe(1);
});
test('read pages are bounded and ack does not delete shared history', async () => {
	await writeFile(
		join(root, 'updates.json'),
		JSON.stringify(Array.from({ length: 25 }, (_, i) => update(100 + i, 'hello'))),
	);
	const first = await readRoom();
	expect(first.events).toHaveLength(20);
	expect(first.more).toBe(true);
	const second = await readRoom(String(first.nextCursor));
	expect(second.events).toHaveLength(5);
	expect(second.more).toBe(false);
	expect((await invoke(['ack', '999'])).code).toBe(1);
	expect((await invoke(['ack', '25'])).code).toBe(0);
	expect((await readRoom('0')).events).toHaveLength(20);
});
test('agent replies reference recorded messages and do not masquerade as human messages', async () => {
	await writeFile(join(root, 'updates.json'), JSON.stringify([update(100, 'hello')]));
	await readRoom();
	expect((await invoke(['reply', '999', 'invalid'])).code).toBe(1);
	expect((await invoke(['reply', '100', 'Ready'], 'success', 'test-agent', '101')).code).toBe(0);
	const request = (await Bun.file(join(root, 'capture')).json()) as {
		reply_parameters: { message_id: number };
	};
	expect(request.reply_parameters.message_id).toBe(100);
	expect((await readRoom()).events.at(-1)?.sender).toEqual({ kind: 'agent', id: 'test-agent' });
});

test('concurrent sync and replay after cursor loss retain one copy of each message', async () => {
	await writeFile(
		join(root, 'updates.json'),
		JSON.stringify([update(100, 'all: hello'), update(101, 'context')]),
	);
	const results = await Promise.all([invoke(['read']), invoke(['read'])]);
	expect(results.map(({ code, err }) => ({ code, err }))).toEqual([
		{ code: 0, err: '' },
		{ code: 0, err: '' },
	]);
	await rm(join(root, 'integrations', 'telegram-state', '123', 'offset'));
	expect((await readRoom()).events.map((event) => event.messageId)).toEqual([100, 101]);
	await Promise.all([invoke(['ack', '2']), invoke(['ack', '1'])]);
	expect((await readRoom()).events).toEqual([]);
});

test('group reads require explicit allowed users and history remains separate by room', async () => {
	await invoke(['send', 'private context']);
	const configPath = join(root, 'integrations', 'telegram.json');
	const config = { botToken: '123:fake-test-token', chatId: '-999' };
	await writeFile(configPath, JSON.stringify(config));
	expect((await invoke(['read'])).err).toContain('allowedUserIds');
	await writeFile(configPath, JSON.stringify({ ...config, allowedUserIds: ['456'] }));
	await writeFile(
		join(root, 'updates.json'),
		JSON.stringify([update(100, 'group context', { chat: { id: -999 } })]),
	);
	expect((await readRoom()).events.map((event) => event.text)).toEqual(['group context']);
});

// The read-only refusal is covered in current-requests-sources.test.ts; this is the other branch:
// an ordinary command restricts a too-open credential file and its folder before reading them.
test.skipIf(process.platform === 'win32')(
	'an ordinary read restricts an open Telegram credential file and folder to the owner',
	async () => {
		const directory = join(root, 'integrations');
		const path = join(directory, 'telegram.json');
		const before = await readFile(path, 'utf8');
		await chmod(directory, 0o755);
		await chmod(path, 0o644);
		const read = await invoke(['read']);
		expect(read.code).toBe(0);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		expect(await readFile(path, 'utf8')).toBe(before);
	},
);
