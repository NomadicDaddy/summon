import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { newRecord } from '../src/store.ts';
import { telegramHarness, update } from './fixtures/telegram-harness.ts';
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
test('mail remains readable when Telegram cannot refresh communication safety', async () => {
	await writeFile(join(root, 'sender.json'), JSON.stringify(newRecord('sender', root, 'codex')));
	const sent = await invoke(
		['send-self', 'test-agent', 'Offline readable message'],
		'success',
		'sender',
		'42',
		'--mail',
	);
	expect(sent.code).toBe(0);
	const received = await invoke(['receive'], 'network', 'test-agent', '42', '--mail');
	expect(received.code).toBe(0);
	expect(received.out).toContain('Offline readable message');
	expect(received.err).toContain('Telegram refresh incomplete');
	expect(received.err).not.toContain('Read receipt could not be delivered');
	const receipt = await invoke(['receive'], 'network', 'sender', '42', '--mail');
	expect(receipt.code).toBe(0);
	expect(receipt.out).toContain('Read receipt for');
});

test('local room attention sends through Telegram and mirrors the accepted message once', async () => {
	const result = await invoke(
		['send', '--to-user', 'A decision is needed'],
		'success',
		'test-agent',
		'42',
		'--room',
	);
	expect(result.code).toBe(0);
	const history = (await Bun.file(join(root, 'room/events.json')).json()) as {
		sender: { kind: string; id: string };
		text: string;
		source: string;
	}[];
	expect(history).toHaveLength(1);
	expect(history[0]?.sender).toEqual({ kind: 'agent', id: 'test-agent' });
	expect(history[0]?.text).toContain('A decision is needed');
	expect(history[0]?.source).toBe('telegram:123:456:42');
});
test('sync repairs a failed outbound local mirror without resending or duplicating it', async () => {
	await writeFile(
		join(root, 'integrations/telegram.json'),
		JSON.stringify({ botToken: '123:fake-test-token', chatId: '456', allowedUserIds: ['456'] }),
	);
	const sent = await invoke(['send', 'Durable outbound message'], 'mirror-failure');
	expect(sent.code).toBe(1);
	expect(sent.err).toContain('recorded in Telegram history');
	expect(sent.err).toContain('Do not resend');
	await rm(join(root, 'room/events.json'), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		expect((await invoke(['sync'], 'success', '')).code).toBe(0);
		const events = (await Bun.file(join(root, 'room/events.json')).json()) as {
			text: string;
		}[];
		expect(events).toHaveLength(1);
		expect(events[0]?.text).toBe('Durable outbound message');
		expect(await Bun.file(join(root, 'capture')).json()).toHaveProperty('allowed_updates');
	}
});

test('sync does not backfill Telegram conversation that predates local mirroring', async () => {
	await invoke(['send', 'Historical Telegram-only post']);
	await writeFile(join(root, 'room/events.json'), '[]');
	expect((await invoke(['sync'], 'success', '')).code).toBe(0);
	expect(await Bun.file(join(root, 'room/events.json')).json()).toEqual([]);
});

test('sends plain text to configured chat with agent attribution and receipt', async () => {
	const result = await invoke(['send', 'Build done <ok>']);
	expect(result.code).toBe(0);
	expect(result.out).toContain('accepted message 42 from test-agent');
	expect(await Bun.file(join(root, 'capture')).json()).toEqual({
		chat_id: '456',
		text: '[test-agent] Build done <ok>',
		link_preview_options: { is_disabled: true },
	});
});
test('status is local and never displays the token', async () => {
	const result = await invoke(['status']);
	expect(result.code).toBe(0);
	expect(result.out).not.toContain('fake-test-token');
	expect(await Bun.file(join(root, 'capture')).exists()).toBe(false);
});

test('user-directed sends and replies highlight only the heading and preserve shared context', async () => {
	const text = 'Ready <now> & **literal** 🚀';
	const heading = '📣 FOR YOU · test-agent';
	expect((await invoke(['send', '--to-user', text])).code).toBe(0);
	expect(await Bun.file(join(root, 'capture')).json()).toEqual({
		chat_id: '456',
		text: `${heading}\n\n${text}`,
		entities: [{ type: 'bold', offset: 0, length: heading.length }],
		link_preview_options: { is_disabled: true },
	});
	expect((await readRoom()).events[0]).toMatchObject({
		text: `📣 FOR YOU\n\n${text}`,
		sender: { kind: 'agent', id: 'test-agent' },
	});
	expect(
		(await invoke(['reply', '--to-user', '42', 'Your answer'], 'success', 'test-agent', '43'))
			.code,
	).toBe(0);
	expect(await Bun.file(join(root, 'capture')).json()).toMatchObject({
		text: `${heading}\n\nYour answer`,
		reply_parameters: { message_id: 42 },
		entities: [{ type: 'bold', offset: 0, length: heading.length }],
	});
	expect((await readRoom()).events.at(-1)?.replyTo).toBe(42);
});

test('user-directed sends validate arguments and length and still obey halt', async () => {
	for (const args of [
		['send', '--to-user'],
		['send', '--to-user', ' '],
		['send', '--to-user', 'x'.repeat(4096)],
		['reply', '--to-user', '42'],
	])
		expect((await invoke(args)).code).toBe(1);
	expect(await Bun.file(join(root, 'capture')).exists()).toBe(false);
	await writeFile(join(root, 'updates.json'), JSON.stringify([update(100, 'halt')]));
	expect((await invoke(['send', '--to-user', 'Blocked'])).err).toContain('paused');
	expect(await Bun.file(join(root, 'capture')).json()).not.toHaveProperty('text');
});
test('missing configuration and invalid calls never send', async () => {
	for (const args of [['send', ''], ['send', 'x'.repeat(4096)], ['send'], ['unknown']])
		expect((await invoke(args)).code).toBe(1);
	expect((await invoke(['send', 'hello'], 'success', '')).code).toBe(1);
	expect((await invoke(['send', 'hello'], 'success', 'missing')).code).toBe(1);
	await rm(join(root, 'integrations', 'telegram.json'));
	expect((await invoke(['send', 'hello'])).err).toContain('not configured');
	expect(await Bun.file(join(root, 'capture')).exists()).toBe(false);
});
test('rejection and uncertain delivery are sanitized failures', async () => {
	for (const mode of ['reject', 'network']) {
		const result = await invoke(['send', 'hello'], mode);
		expect(result.code).toBe(1);
		expect(result.err).not.toContain('sensitive');
		expect(result.err).not.toContain('fake-test-token');
	}
});

test('halt is enforced before sending, only explicit human proceed resumes, and replay cannot resume twice', async () => {
	await writeFile(join(root, 'updates.json'), JSON.stringify([update(100, ' HaLt ')]));
	expect((await invoke(['send', 'Must not send'])).err).toContain('paused');
	const request = (await Bun.file(join(root, 'capture')).json()) as Record<string, unknown>;
	expect(request).not.toHaveProperty('text');
	const statePath = join(root, 'communications', 'state.json');
	const halted = (await Bun.file(statePath).json()) as Record<string, unknown>;
	expect(halted).toMatchObject({
		paused: true,
		attribution: { channel: 'telegram', actor: { kind: 'telegram-user', id: '456' } },
	});
	expect((await readRoom()).events[0]?.text).toBe(' HaLt ');
	await writeFile(
		join(root, 'updates.json'),
		JSON.stringify([
			update(101, 'proceed', { from: { id: 789, is_bot: false } }),
			update(102, 'proceed', { from: { id: 456, is_bot: true } }),
			update(103, 'proceed', { forward_origin: { type: 'user' } }),
			update(104, 'please proceed'),
		]),
	);
	expect((await invoke(['send', 'Still blocked'])).err).toContain('paused');
	expect(await Bun.file(statePath).json()).toEqual(halted);
	await writeFile(join(root, 'updates.json'), JSON.stringify([update(105, 'PROCEED')]));
	expect((await invoke(['send', 'Allowed now'])).code).toBe(0);
	const state = (await Bun.file(statePath).json()) as {
		paused: boolean;
		source: string;
		changedAt: number;
	};
	expect(state).toMatchObject({
		paused: false,
		attribution: { channel: 'telegram', actor: { kind: 'telegram-user', id: '456' } },
	});
	state.paused = true;
	state.source = 'local';
	state.changedAt = Date.now();
	await writeFile(statePath, JSON.stringify(state));
	await rm(join(root, 'integrations', 'telegram-state', '123', 'offset'));
	expect((await invoke(['send', 'Replay cannot clear'])).err).toContain('paused');
	await writeFile(
		join(root, 'updates.json'),
		JSON.stringify([update(106, 'proceed', { date: 1 })]),
	);
	expect((await invoke(['send', 'Old proceed cannot clear'])).err).toContain('paused');
});
