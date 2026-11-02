import { expect, spyOn, test } from 'bun:test';
import { rm } from 'node:fs/promises';

import type { WakePart, WakeSend } from '../src/wake-part.ts';

import { setHibernation } from '../src/hibernation.ts';
import { NotificationNotSentError } from '../src/notification-delivery.ts';
import * as owners from '../src/process-owner.ts';
import * as store from '../src/wake-delivery-store.ts';
import { deliverWakeParts } from '../src/wake-delivery.ts';
import { holdWatchdogLock, notice, useWakeFixture } from './fixtures/wake-failure.ts';

// Each category names the call boundary that threw, at exactly that step.
useWakeFixture();

async function deliver(
	nonce: string,
	options: { allowed?: boolean; part?: Partial<WakePart>; send?: WakeSend } = {},
): Promise<unknown> {
	return deliverWakeParts(
		'alpha',
		nonce,
		[notice(nonce, options.part)],
		options.send ?? (() => Promise.resolve()),
		() => Promise.resolve(options.allowed ?? true),
	).catch((error: unknown) => error);
}

async function latest(nonce: string) {
	const value = (await store.wakeDeliveryStatus('alpha', nonce)).latest;
	if (!value) throw new Error('Missing latest wake outcome.');
	return value;
}

type Category = NonNullable<Awaited<ReturnType<typeof latest>>['failure']>['category'];

async function asOperator(action: () => Promise<void>): Promise<void> {
	const agent = process.env.SUMMON_AGENT;
	delete process.env.SUMMON_AGENT;
	try {
		await action();
	} finally {
		process.env.SUMMON_AGENT = agent;
	}
}

test('a busy watchdog lock is watchdog-retention with a live-probe sample taken after it', async () => {
	const lock = await holdWatchdogLock();
	try {
		expect(await deliver('retention')).toBeInstanceOf(NotificationNotSentError);
	} finally {
		await rm(lock.path, { force: true });
	}
	expect((await latest('retention')).failure).toEqual({
		category: 'watchdog-retention',
		sampledAfterFailure: { lock: 'probe-alive', ageBucket: '<1m' },
	});
}, 30_000);

test('each pre-input step and the send itself name their own boundary', async () => {
	let checks = 0;
	const cases: [string, Parameters<typeof deliver>[1], Category, string][] = [
		[
			'mark',
			{
				part: {
					mark: (state) =>
						state === 'attempted' ? Promise.reject(new Error('x')) : Promise.resolve(),
				},
			},
			'mark-attempted',
			'not-sent',
		],
		['ownership', { allowed: false }, 'ownership-boundary', 'not-sent'],
		[
			'suppression',
			{
				part: {
					needed: () =>
						checks++ ? Promise.reject(new Error('x')) : Promise.resolve(true),
				},
			},
			'other',
			'not-sent',
		],
		[
			'refused',
			{ send: () => Promise.reject(new NotificationNotSentError('draft')) },
			'send-refused',
			'not-sent',
		],
		[
			'uncertain',
			{ send: () => Promise.reject(new Error('provider')) },
			'send-uncertain',
			'uncertain',
		],
		[
			'queued',
			{
				part: {
					mark: (state) =>
						state === 'queued' ? Promise.reject(new Error('x')) : Promise.resolve(),
				},
			},
			'after-send',
			'uncertain',
		],
	];
	for (const [nonce, options, category, state] of cases) {
		await deliver(nonce, options);
		const value = await latest(nonce);
		expect([nonce, value.state, value.failure]).toEqual([nonce, state, { category }]);
		expect(value.previousFailure).toBeUndefined();
	}
});

test('a closed notice gate before input is notice-paused', async () => {
	await asOperator(() => setHibernation('alpha', true));
	let sends = 0;
	expect(
		await deliver('paused', {
			send: () => {
				sends++;
				return Promise.resolve();
			},
		}),
	).toBeInstanceOf(NotificationNotSentError);
	expect(sends).toBe(0);
	expect((await latest('paused')).failure).toEqual({ category: 'notice-paused' });
});

test('a failed provider-submitted save after send resolves is after-send, never a send failure', async () => {
	const save = store.saveWakeOutcome;
	const spy = spyOn(store, 'saveWakeOutcome').mockImplementation((value, current) =>
		value.state === 'provider-submitted'
			? Promise.reject(new Error('disk'))
			: save(value, current),
	);
	try {
		expect(await deliver('submitted-save')).toBe('uncertain');
	} finally {
		spy.mockRestore();
	}
	const value = await latest('submitted-save');
	expect(value.state).toBe('uncertain');
	expect(value.failure).toEqual({ category: 'after-send' });
	const raw: unknown = JSON.parse(await Bun.file(store.outcomePath('alpha', value.id)).text());
	expect(raw).toHaveProperty('retryAt', 0);
});

test('a sampler that throws leaves the outcome and the rethrown error unchanged', async () => {
	// The probe fails only once the not-sent outcome is durable, so the lock itself still
	// refuses as it would in production and only the after-failure sample sees the throw.
	const alive = owners.processAlive;
	let sampling = false;
	const probe = spyOn(owners, 'processAlive').mockImplementation((pid) => {
		if (sampling) throw new Error('probe');
		return alive(pid);
	});
	const save = store.saveWakeOutcome;
	const saved = spyOn(store, 'saveWakeOutcome').mockImplementation(async (value, current) => {
		await save(value, current);
		if (value.state === 'not-sent') sampling = true;
	});
	const lock = await holdWatchdogLock();
	let error: unknown;
	try {
		error = await deliver('sampler');
	} finally {
		probe.mockRestore();
		saved.mockRestore();
		await rm(lock.path, { force: true });
	}
	expect(error).toBeInstanceOf(NotificationNotSentError);
	expect(error instanceof Error && error.cause).toBeInstanceOf(Error);
	const value = await latest('sampler');
	expect(value.state).toBe('not-sent');
	expect(value.attempts).toBe(1);
	expect(value.failure).toEqual({
		category: 'watchdog-retention',
		sampledAfterFailure: { lock: 'read-error', ageBucket: 'stat-error' },
	});
}, 30_000);
