import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { communicationSend } from '../src/communication-gate.ts';
import { communicationState } from '../src/communication-state.ts';
import {
	refreshTelegramForLocal,
	type TelegramUnavailable,
} from '../src/telegram-local-refresh.ts';
import { syncTelegram } from '../src/telegram-sync.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

const config = { botToken: '123:test-token', chatId: '456', allowedUserIds: ['456'] };
const originalFetch = globalThis.fetch;
const originalRoot = process.env.SUMMON_HOME;
const originalAgent = process.env.SUMMON_AGENT;
let fixture: Awaited<ReturnType<typeof mailHarness>>;

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = '';
	await mkdir(join(fixture.records, 'integrations'));
	await writeFile(join(fixture.records, 'integrations/telegram.json'), JSON.stringify(config));
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (originalRoot === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = originalRoot;
	if (originalAgent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = originalAgent;
	await fixture.dispose();
});

async function until(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (check()) return;
		await Bun.sleep(20);
	}
	throw new Error('Telegram poll did not begin.');
}

test('a Room send fetches again after an older poll and observes a later Halt', async () => {
	const first = Promise.withResolvers<Response>();
	let requests = 0;
	globalThis.fetch = Object.assign(
		() => {
			requests++;
			return requests === 1
				? first.promise
				: Promise.resolve(
						Response.json({
							ok: true,
							result: [
								{
									update_id: 1,
									message: {
										message_id: 1,
										date: Math.floor(Date.now() / 1000),
										chat: { id: 456 },
										from: { id: 456, is_bot: false },
										text: 'halt',
									},
								},
							],
						}),
					);
		},
		{ preconnect: originalFetch.preconnect },
	);
	const polling = syncTelegram(config);
	await until(() => requests === 1);
	let sent = false;
	const sending = communicationSend('send the Room post', () => {
		sent = true;
		return Promise.resolve();
	}).catch((error: unknown) => error);
	try {
		await Bun.sleep(1_300);
		expect(sent).toBe(false);
		expect(requests).toBe(1);
	} finally {
		first.resolve(Response.json({ ok: true, result: [] }));
	}
	await polling;
	expect(String(await sending)).toContain('Halt:');
	expect((await communicationState()).paused).toBe(true);
	expect(sent).toBe(false);
	expect(requests).toBe(2);
	expect(await fixture.read('integrations/telegram-state/123/offset')).toBe('2');
}, 10_000);

test('a read reports cached-only promptly while another poll is still pending', async () => {
	const first = Promise.withResolvers<Response>();
	let requests = 0;
	globalThis.fetch = Object.assign(
		() => {
			requests++;
			return first.promise;
		},
		{ preconnect: originalFetch.preconnect },
	);
	const polling = syncTelegram(config);
	await until(() => requests === 1);
	const unavailable: TelegramUnavailable[] = [];
	const refreshed = refreshTelegramForLocal(config, false, (_reason, kind) => {
		unavailable.push(kind);
	});
	try {
		await refreshed;
		expect(unavailable).toEqual(['refresh-busy']);
		expect(requests).toBe(1);
	} finally {
		first.resolve(Response.json({ ok: true, result: [] }));
		await polling;
	}
}, 10_000);

test('a local send reports cached-only after its bounded wait expires', async () => {
	const lock = join(fixture.records, 'integrations/telegram-state/123/poll.lock');
	await mkdir(join(fixture.records, 'integrations/telegram-state/123'), { recursive: true });
	await writeFile(lock, JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
	let requests = 0;
	globalThis.fetch = Object.assign(
		() => {
			requests++;
			return Promise.resolve(Response.json({ ok: true, result: [] }));
		},
		{ preconnect: originalFetch.preconnect },
	);
	const unavailable: TelegramUnavailable[] = [];
	const started = Date.now();
	await refreshTelegramForLocal(config, true, (_reason, kind) => {
		unavailable.push(kind);
	});
	expect(Date.now() - started).toBeGreaterThan(6_000);
	expect(unavailable).toEqual(['refresh-busy']);
	expect(requests).toBe(0);
}, 15_000);

test('a failed fetch after acquiring the lock remains an explicit cached-only result', async () => {
	globalThis.fetch = Object.assign(
		() => Promise.resolve(Response.json({ ok: false }, { status: 502 })),
		{ preconnect: originalFetch.preconnect },
	);
	const unavailable: TelegramUnavailable[] = [];
	await refreshTelegramForLocal(config, true, (_reason, kind) => {
		unavailable.push(kind);
	});
	expect(unavailable).toEqual(['request-failed']);
});
