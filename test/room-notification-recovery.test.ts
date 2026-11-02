import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { appendLocalEvent } from '../src/local-room.ts';
import { NotificationNotSentError } from '../src/notification-delivery.ts';
import { localCursorPath } from '../src/room-cursor.ts';
import { roomCursorPath } from '../src/telegram-live.ts';
import { recordRoomEvent } from '../src/telegram-room.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { notifyLocalRoom, notifyRoom } from './fixtures/wake-notice.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const originalFetch = globalThis.fetch;
const originalHome = process.env.SUMMON_HOME;
const originalAgent = process.env.SUMMON_AGENT;
const config = { botToken: '123:fixture', chatId: '456', allowedUserIds: ['456'] };

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = '';
	await mkdir(join(fixture.records, 'integrations'));
	await writeFile(join(fixture.records, 'integrations/telegram.json'), JSON.stringify(config));
	globalThis.fetch = Object.assign(
		() => Promise.resolve(Response.json({ ok: true, result: [] })),
		{ preconnect: originalFetch.preconnect },
	);
});
afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (originalHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = originalHome;
	if (originalAgent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = originalAgent;
	await fixture.dispose();
});

for (const transport of ['local', 'telegram'] as const) {
	function route(nonce: string) {
		let next = 1000;
		return {
			notify: (send: (text: string) => Promise<void>) =>
				transport === 'local'
					? notifyLocalRoom('alpha', nonce, send)
					: notifyRoom('alpha', nonce, send),
			cursor: () =>
				transport === 'local' ? localCursorPath('alpha') : roomCursorPath(config, 'alpha'),
			async post(
				text: string,
				kind: 'user' | 'agent' = 'agent',
				id = 'beta',
				replyTo: number | null = null,
			) {
				if (transport === 'local')
					return (
						await appendLocalEvent({
							sender: { kind, id },
							text,
							replyTo,
							source: 'local',
						})
					).id;
				return (
					await recordRoomEvent(config, {
						messageId: ++next,
						sender: { kind, id },
						text,
						replyTo,
					})
				).messageId;
			},
		};
	}

	test(`${transport} retries a definitely unsent wake without acknowledging history`, async () => {
		const r = route('definite');
		await r.post('@alpha request');
		const sent: string[] = [];
		let blocked = true;
		const send = (text: string): Promise<void> => {
			if (blocked) return Promise.reject(new NotificationNotSentError('draft still present'));
			sent.push(text);
			return Promise.resolve();
		};
		expect(await r.notify(send).catch((error: unknown) => error)).toBeInstanceOf(
			NotificationNotSentError,
		);
		blocked = false;
		await Bun.sleep(2100);
		await r.notify(send);
		await r.notify(send);
		expect(sent).toHaveLength(1);
		expect(await Bun.file(r.cursor()).exists()).toBe(false);
	});

	for (const outcome of ['queued', 'failed', 'attempted'] as const) {
		test(`${transport} ${outcome} wake refreshes only for new protected traffic`, async () => {
			const r = route(`refresh-${outcome}`);
			await r.post('@alpha first');
			const sent: string[] = [];
			const send = (text: string): Promise<void> => {
				sent.push(text);
				return Promise.resolve();
			};
			if (outcome === 'attempted') {
				const suffix = transport === 'local' ? 'room' : 'telegram-123-456';
				const path = join(
					fixture.records,
					'runtime/alpha',
					`refresh-attempted-${suffix}.notice`,
				);
				await mkdir(join(fixture.records, 'runtime/alpha'), { recursive: true });
				await writeFile(path, JSON.stringify({ through: 1, state: 'attempted' }));
			} else if (outcome === 'failed') {
				await r.notify(() => Promise.reject(new Error('delivery uncertain')));
			} else await r.notify(send);
			const initial = sent.length;
			await r.notify(send);
			expect(sent).toHaveLength(initial);
			const ownId = await r.post('own reply', 'agent', 'alpha');
			await r.post('routine peer traffic');
			await r.notify(send);
			expect(sent).toHaveLength(initial);
			await r.post('reply without a mention', 'agent', 'beta', ownId);
			await r.notify(send);
			expect(sent).toHaveLength(initial + 1);
			expect(sent.at(-1)).toContain('through 4');
			await r.post('new human request', 'user', 'operator');
			await r.notify(send);
			expect(sent).toHaveLength(initial + 2);
			await r.post('@alpha new addressed request');
			await r.notify(send);
			await r.notify(send);
			expect(sent).toHaveLength(initial + 3);
			expect(sent.at(-1)).toContain('through 6');
			expect(await Bun.file(r.cursor()).exists()).toBe(false);
		});
	}
}
