import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { communicationSend } from '../src/communication-gate.ts';
import { setCommunicationPause } from '../src/communication-state.ts';
import { localEvents } from '../src/local-room.ts';
import { syncTelegram } from '../src/telegram-sync.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { update } from './fixtures/telegram-harness.ts';

const config = { botToken: '123:fixture', chatId: '456', allowedUserIds: ['456'] };
const original = process.env.SUMMON_HOME;
let fixture: Awaited<ReturnType<typeof mailHarness>>;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await mkdir(join(fixture.records, 'integrations'));
	await writeFile(join(fixture.records, 'integrations/telegram.json'), JSON.stringify(config));
});
afterEach(async () => {
	if (original === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = original;
	await fixture.dispose();
});

test('operator failure and recovery notices deduplicate, redact, and obey recorded halt', async () => {
	const fetch = spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(
			() =>
				Promise.resolve(
					Response.json({ ok: false, description: 'PRIVATE_CANARY' }, { status: 401 }),
				),
			{ preconnect: globalThis.fetch.preconnect },
		),
	);
	try {
		await setCommunicationPause(true);
		await syncTelegram(config).catch(() => undefined);
		expect(await localEvents()).toEqual([]);
		await setCommunicationPause(false);
		await syncTelegram(config).catch(() => undefined);
		await syncTelegram(config).catch(() => undefined);
		let events = await localEvents();
		expect(events).toHaveLength(1);
		expect(events[0]?.text).toContain('HTTP 401');
		// In Proceed, the notice names the recorded state without asserting a halt (#22292).
		expect(events[0]?.text).toContain('Local work uses the recorded communication state');
		expect(events[0]?.text).not.toContain('halt state');
		expect(JSON.stringify(events)).not.toContain('PRIVATE_CANARY');
		expect(JSON.stringify(events)).not.toContain(config.botToken);
		const path = join(fixture.records, 'integrations/telegram-state/123/health.json');
		const episode = JSON.parse(await readFile(path, 'utf8')) as {
			id: string;
			reason: string;
			announced: boolean;
		};
		await writeFile(path, JSON.stringify({ ...episode, announced: false }));
		await syncTelegram(config).catch(() => undefined);
		expect(await localEvents()).toHaveLength(1);
		fetch.mockImplementation(
			Object.assign(() => Promise.resolve(Response.json({ ok: true, result: [] })), {
				preconnect: globalThis.fetch.preconnect,
			}),
		);
		await setCommunicationPause(true);
		await syncTelegram(config);
		expect(await localEvents()).toHaveLength(1);
		await setCommunicationPause(false);
		await syncTelegram(config);
		await syncTelegram(config);
		events = await localEvents();
		expect(events).toHaveLength(2);
		expect(events[1]?.text).toContain('Telegram refresh recovered.');
		expect(events[1]?.text).toContain(
			'Recovery alone does not change the recorded communication state.',
		);
		expect(events[1]?.text).not.toContain('halt state');
		fetch.mockRejectedValue(
			Object.assign(new Error('PRIVATE_CANARY'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
		);
		await syncTelegram(config).catch(() => undefined);
		events = await localEvents();
		expect(events).toHaveLength(3);
		expect(events[2]?.text).toContain('TLS certificate verification failed');
	} finally {
		fetch.mockRestore();
	}
});

test('a local writer waits for a healthy in-flight poll and enforces its halt', async () => {
	const entered = Promise.withResolvers<boolean>();
	const response = Promise.withResolvers<Response>();
	let calls = 0;
	const fetch = spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(
			() => {
				calls++;
				entered.resolve(true);
				return calls === 1
					? response.promise
					: Promise.resolve(Response.json({ ok: true, result: [] }));
			},
			{ preconnect: globalThis.fetch.preconnect },
		),
	);
	const warning = spyOn(console, 'warn').mockImplementation(() => {});
	const polling = syncTelegram(config);
	try {
		await entered.promise;
		let sent = false;
		const sending = communicationSend('send the Room post', () => {
			sent = true;
			return Promise.resolve();
		}).catch((error: unknown) => String(error));
		await Bun.sleep(400);
		expect(sent).toBe(false);
		response.resolve(Response.json({ ok: true, result: [update(1, 'halt')] }));
		await polling;
		expect(await sending).toContain('Halt:');
		expect(sent).toBe(false);
		expect(warning).not.toHaveBeenCalled();
		expect(
			(await localEvents()).some((event) => event.source.startsWith('telegram-health:')),
		).toBe(false);
	} finally {
		response.resolve(Response.json({ ok: true, result: [] }));
		await polling;
		fetch.mockRestore();
		warning.mockRestore();
	}
});
