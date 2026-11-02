import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { setCommunicationPause } from '../src/communication-state.ts';
import { localEvents } from '../src/local-room.ts';
import { TRANSIENT_FAILURE_GRACE_MS } from '../src/telegram-health.ts';
import { syncTelegram } from '../src/telegram-sync.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

/*
 * Transient Telegram refresh failures stay quiet until they persist past a grace period (#14147);
 * configuration and certificate failures are still announced at once.
 */
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

/** Answers every Telegram call with one outcome until changed. */
function telegramAnswers() {
	const fetch = spyOn(globalThis, 'fetch');
	const answer = (reply: () => Promise<Response>) =>
		fetch.mockImplementation(Object.assign(reply, { preconnect: globalThis.fetch.preconnect }));
	return {
		fetch,
		healthy: () => answer(() => Promise.resolve(Response.json({ ok: true, result: [] }))),
		status: (status: number) =>
			answer(() => Promise.resolve(Response.json({ ok: false }, { status }))),
		dropped: (code: string) =>
			answer(() => Promise.reject(Object.assign(new Error('PRIVATE_CANARY'), { code }))),
		timedOut: () =>
			answer(() =>
				Promise.reject(
					Object.assign(new Error('PRIVATE_CANARY'), { name: 'TimeoutError' }),
				),
			),
	};
}

const healthPath = () => join(fixture.records, 'integrations/telegram-state/123/health.json');

/** Moves the open episode's start back past the grace period, as if it had persisted that long. */
async function persistedPastGrace(): Promise<void> {
	const then = new Date(Date.now() - TRANSIENT_FAILURE_GRACE_MS - 1_000);
	await utimes(healthPath(), then, then);
}

test('a transient failure that clears on the next refresh posts nothing', async () => {
	const telegram = telegramAnswers();
	try {
		for (const fail of [
			() => telegram.timedOut(),
			() => telegram.dropped('ECONNRESET'),
			() => telegram.dropped('EAI_AGAIN'),
			() => telegram.status(429),
			() => telegram.status(502),
		]) {
			fail();
			await syncTelegram(config).catch(() => undefined);
			await syncTelegram(config).catch(() => undefined);
			telegram.healthy();
			await syncTelegram(config);
			expect(await readFile(healthPath(), 'utf8')).toBe('null');
		}
		expect(await localEvents()).toEqual([]);
	} finally {
		telegram.fetch.mockRestore();
	}
});

test('a transient failure that persists past the grace period is announced once, then recovers once', async () => {
	const telegram = telegramAnswers();
	try {
		telegram.dropped('ECONNRESET');
		await syncTelegram(config).catch(() => undefined);
		expect(await localEvents()).toEqual([]);
		// The stored episode keeps the shape older builds parse strictly.
		expect(Object.keys(JSON.parse(await readFile(healthPath(), 'utf8')) as object)).toEqual([
			'id',
			'reason',
			'announced',
		]);
		await persistedPastGrace();
		await syncTelegram(config).catch(() => undefined);
		await syncTelegram(config).catch(() => undefined);
		let events = await localEvents();
		expect(events).toHaveLength(1);
		expect(events[0]?.text).toContain('The connection to Telegram was reset.');
		expect(JSON.stringify(events)).not.toContain('PRIVATE_CANARY');
		telegram.healthy();
		await syncTelegram(config);
		await syncTelegram(config);
		events = await localEvents();
		expect(events).toHaveLength(2);
		expect(events[1]?.text).toContain('Telegram refresh recovered.');
		expect(events[1]?.source).toBe(events[0]?.source.replace(':failed', ':recovered'));
	} finally {
		telegram.fetch.mockRestore();
	}
});

test('the grace period holds just inside its boundary and releases just past it', async () => {
	const telegram = telegramAnswers();
	try {
		telegram.timedOut();
		await syncTelegram(config).catch(() => undefined);
		const inside = new Date(Date.now() - TRANSIENT_FAILURE_GRACE_MS + 5_000);
		await utimes(healthPath(), inside, inside);
		await syncTelegram(config).catch(() => undefined);
		expect(await localEvents()).toEqual([]);
		await persistedPastGrace();
		await syncTelegram(config).catch(() => undefined);
		expect(await localEvents()).toHaveLength(1);
	} finally {
		telegram.fetch.mockRestore();
	}
});

test('a start a moment ahead of the clock is still inside the grace period', async () => {
	const telegram = telegramAnswers();
	try {
		telegram.timedOut();
		await syncTelegram(config).catch(() => undefined);
		// File times can read a little ahead of Date.now(); that alone must not announce a blip.
		const ahead = new Date(Date.now() + 1_000);
		await utimes(healthPath(), ahead, ahead);
		await syncTelegram(config).catch(() => undefined);
		expect(await localEvents()).toEqual([]);
	} finally {
		telegram.fetch.mockRestore();
	}
});

test('an episode start in the future cannot suppress a persistent failure', async () => {
	const telegram = telegramAnswers();
	try {
		telegram.timedOut();
		await syncTelegram(config).catch(() => undefined);
		// A clock moved back after the episode opened leaves its start ahead of now.
		const future = new Date(Date.now() + 10 * 60_000);
		await utimes(healthPath(), future, future);
		await syncTelegram(config).catch(() => undefined);
		expect(await localEvents()).toHaveLength(1);
	} finally {
		telegram.fetch.mockRestore();
	}
});

test('a configuration failure is announced at once, even inside an open transient episode', async () => {
	const telegram = telegramAnswers();
	try {
		telegram.timedOut();
		await syncTelegram(config).catch(() => undefined);
		telegram.status(401);
		await syncTelegram(config).catch(() => undefined);
		const events = await localEvents();
		expect(events).toHaveLength(1);
		expect(events[0]?.text).toContain('HTTP 401');
	} finally {
		telegram.fetch.mockRestore();
	}
});

test('every certificate failure is announced at once', async () => {
	const telegram = telegramAnswers();
	try {
		for (const [at, code] of [
			'CERT_HAS_EXPIRED',
			'DEPTH_ZERO_SELF_SIGNED_CERT',
			'ERR_TLS_CERT_ALTNAME_INVALID',
		].entries()) {
			telegram.dropped(code);
			await syncTelegram(config).catch(() => undefined);
			const events = await localEvents();
			expect(events).toHaveLength(at * 2 + 1);
			expect(events.at(-1)?.text).toContain('Telegram TLS certificate verification failed.');
			telegram.healthy();
			await syncTelegram(config);
			expect(await localEvents()).toHaveLength(at * 2 + 2);
		}
	} finally {
		telegram.fetch.mockRestore();
	}
});

test('a recorded halt holds a persisted transient failure until it is lifted', async () => {
	const telegram = telegramAnswers();
	try {
		telegram.timedOut();
		await syncTelegram(config).catch(() => undefined);
		await persistedPastGrace();
		await setCommunicationPause(true);
		await syncTelegram(config).catch(() => undefined);
		expect(await localEvents()).toEqual([]);
		await setCommunicationPause(false);
		await syncTelegram(config).catch(() => undefined);
		expect(await localEvents()).toHaveLength(1);
	} finally {
		telegram.fetch.mockRestore();
	}
});
