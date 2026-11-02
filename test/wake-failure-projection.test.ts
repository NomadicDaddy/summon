import { expect, spyOn, test } from 'bun:test';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

import { checkpointHash } from '../src/checkpoint-package-model.ts';
import { scopedMail } from '../src/mailbox-commands.ts';
import { NotificationNotSentError } from '../src/notification-delivery.ts';
import { normalized, outcomePath, wakeDeliveryStatus } from '../src/wake-delivery-store.ts';
import { deliverWakeParts } from '../src/wake-delivery.ts';
import { failurePath } from '../src/wake-failure.ts';
import { holdWatchdogLock, notice, useWakeFixture } from './fixtures/wake-failure.ts';

// What own status shows from the failure record, through the real status projection.
useWakeFixture();

function deliver(nonce: string, send: () => Promise<void>): Promise<unknown> {
	return deliverWakeParts('alpha', nonce, [notice(nonce)], send, () =>
		Promise.resolve(true),
	).catch((error: unknown) => error);
}

const refuse = () => Promise.reject(new NotificationNotSentError('PRIVATE_REFUSAL'));

async function latest(nonce: string) {
	const value = (await wakeDeliveryStatus('alpha', nonce)).latest;
	if (!value) throw new Error('Missing latest wake outcome.');
	return value;
}

/** Fails once, then moves the clock past the retry so the next attempt runs. */
async function failThenRetry(nonce: string, retry: () => Promise<void>) {
	let now = Date.now();
	const clock = spyOn(Date, 'now').mockImplementation(() => now);
	try {
		await deliver(nonce, refuse);
		const first = await latest(nonce);
		const sidecar = await readFile(failurePath('alpha', first.id), 'utf8');
		now += 2001;
		await new Promise((resolve) => setTimeout(resolve, 5));
		const result = await deliver(nonce, retry);
		return { first, sidecar, result };
	} finally {
		clock.mockRestore();
	}
}

test('the failure record carries no pid, nonce, path, message or stack', async () => {
	const lock = await holdWatchdogLock();
	try {
		await deliver('privacy', refuse);
	} finally {
		await rm(lock.path, { force: true });
	}
	const value = await latest('privacy');
	const sidecar = await readFile(failurePath('alpha', value.id), 'utf8');
	expect(Object.keys(JSON.parse(sidecar) as object).sort()).toEqual([
		'attempts',
		'category',
		'lastFailureAt',
		'sampledAfterFailure',
		'version',
	]);
	for (const shown of [sidecar, JSON.stringify(value.failure)]) {
		expect(shown).not.toContain(lock.nonce);
		expect(shown).not.toContain('privacy');
		expect(shown).not.toContain('PRIVATE_');
		expect(shown).not.toContain('pid');
		expect(shown).not.toContain('Error');
		expect(shown).not.toMatch(/[\\/]|\bat\s/);
	}
}, 30_000);

test('an outcome without a failure record shows neither field', async () => {
	await deliver('plain', () => Promise.reject(new Error('provider')));
	const value = await latest('plain');
	await rm(failurePath('alpha', value.id));
	const shown = await latest('plain');
	expect(shown.state).toBe('uncertain');
	expect(shown.failure).toBeUndefined();
	expect(shown.previousFailure).toBeUndefined();
});

test('a successful retry shows the earlier failure as previous, never as current', async () => {
	const { result } = await failThenRetry('recovered', () => Promise.resolve());
	expect(result).toBe('submitted');
	const value = await latest('recovered');
	expect(value.state).toBe('provider-submitted');
	expect(value.attempts).toBe(2);
	expect(value.failure).toBeUndefined();
	expect(value.previousFailure).toEqual({
		category: 'send-refused',
		recoveredAt: value.recoveredAt ?? '',
	});
	const status = await scopedMail(['status']);
	expect(JSON.stringify(status)).not.toContain('PRIVATE_');
});

test('a second failure whose record was not saved shows nothing, not the first as current', async () => {
	const { first, sidecar } = await failThenRetry('second', refuse);
	const value = await latest('second');
	expect(value.state).toBe('not-sent');
	expect(value.attempts).toBe(2);
	// Restoring the first record stands in for a second write that failed.
	await writeFile(failurePath('alpha', first.id), sidecar);
	const shown = await latest('second');
	expect(shown.failure).toBeUndefined();
	expect(shown.previousFailure).toBeUndefined();
});

test('a current failure whose record has other attempts or another failure time shows nothing', async () => {
	await deliver('mismatch', refuse);
	const value = await latest('mismatch');
	const path = failurePath('alpha', value.id);
	const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
	await writeFile(path, JSON.stringify({ ...record, attempts: 2 }));
	expect((await latest('mismatch')).failure).toBeUndefined();
	await writeFile(path, JSON.stringify({ ...record, lastFailureAt: '2026-01-01T00:00:00.000Z' }));
	expect((await latest('mismatch')).failure).toBeUndefined();
});

test('a valid record past the 4 KiB read bound is omitted by the bound alone', async () => {
	await deliver('bounded', refuse);
	const value = await latest('bounded');
	const path = failurePath('alpha', value.id);
	const record = await readFile(path, 'utf8');
	// Trailing whitespace keeps the JSON valid and strict, so only the byte bound can omit it.
	await writeFile(path, record + ' '.repeat(4096 - Buffer.byteLength(record)));
	expect((await latest('bounded')).failure).toEqual({ category: 'send-refused' });
	await writeFile(path, record + ' '.repeat(4097 - Buffer.byteLength(record)));
	expect((await latest('bounded')).failure).toBeUndefined();
});

test('a failure record that cannot be written leaves the refusal and its outcome intact', async () => {
	const nonce = 'blocked';
	const target = { source: 'readiness' as const, key: nonce, through: 0, ids: [] };
	const path = failurePath('alpha', checkpointHash(['alpha', nonce, normalized([target])]));
	await mkdir(path, { recursive: true });
	let sends = 0;
	const error: unknown = await deliverWakeParts(
		'alpha',
		nonce,
		[notice(nonce)],
		() => {
			sends++;
			return Promise.resolve();
		},
		() => Promise.resolve(false),
	).catch((thrown: unknown) => thrown);
	expect(error).toBeInstanceOf(NotificationNotSentError);
	const cause = error instanceof Error ? error.cause : undefined;
	expect(cause).toBeInstanceOf(NotificationNotSentError);
	expect(String(cause)).toContain('Receiver ownership or read boundary changed.');
	expect(sends).toBe(0);
	const value = await latest(nonce);
	expect(value.state).toBe('not-sent');
	expect(value.attempts).toBe(1);
	const raw = JSON.parse(await readFile(outcomePath('alpha', value.id), 'utf8')) as {
		retryAt: number;
	};
	expect(raw.retryAt).toBeGreaterThan(Date.now());
	expect(value.failure).toBeUndefined();
	expect((await stat(path)).isDirectory()).toBe(true);
});

test('a malformed or unreadable failure record shows nothing and status returns', async () => {
	await deliver('damaged', refuse);
	const value = await latest('damaged');
	const path = failurePath('alpha', value.id);
	const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
	const damaged = [JSON.stringify({ ...record, extra: 1 }), '{"category":'];
	for (const text of damaged) {
		await writeFile(path, text);
		expect((await latest('damaged')).failure).toBeUndefined();
	}
	await rm(path);
	await mkdir(path);
	expect((await latest('damaged')).failure).toBeUndefined();
	expect((await wakeDeliveryStatus('alpha', 'damaged')).total).toBe(1);
});
