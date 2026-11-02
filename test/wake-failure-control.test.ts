import { expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { z } from 'zod';

import { outcomePath, wakeDeliveryStatus } from '../src/wake-delivery-store.ts';
import { deliverWakeParts } from '../src/wake-delivery.ts';
import { holdWatchdogLock, notice, useWakeFixture } from './fixtures/wake-failure.ts';

// Clause 7 control: two pre-input refusals that need different follow-up must be told apart
// in own status, while the retry and no-retry rules they share stay exactly as they are.
// Run against ee11aa9 unchanged, the first test fails and the two pins pass.
useWakeFixture();

const projected = z.object({ failure: z.object({ category: z.string() }).optional() });
const retained = z.object({ retryAt: z.number() });

async function semantic(nonce: string) {
	const latest = (await wakeDeliveryStatus('alpha', nonce)).latest;
	if (!latest) throw new Error('Missing latest wake outcome.');
	const raw = retained.parse(JSON.parse(await Bun.file(outcomePath('alpha', latest.id)).text()));
	return {
		state: latest.state,
		stage: latest.stage,
		attempts: latest.attempts,
		retryScheduled: raw.retryAt > 0,
		category: projected.parse(latest).failure?.category,
	};
}

async function lockBusy(sent: () => void): Promise<void> {
	const lock = await holdWatchdogLock();
	try {
		const result: unknown = await deliverWakeParts(
			'alpha',
			'lock-busy',
			[notice('lock-busy')],
			() => {
				sent();
				return Promise.resolve();
			},
			() => Promise.resolve(true),
		).catch((error: unknown) => error);
		expect(result).toBeInstanceOf(Error);
	} finally {
		await rm(lock.path, { force: true });
	}
}

test('a busy watchdog lock and a closed ownership boundary read differently in own status', async () => {
	await lockBusy(() => undefined);
	const refused: unknown = await deliverWakeParts(
		'alpha',
		'ownership',
		[notice('ownership')],
		() => Promise.resolve(),
		() => Promise.resolve(false),
	).catch((error: unknown) => error);
	expect(refused).toBeInstanceOf(Error);
	expect(await semantic('lock-busy')).not.toEqual(await semantic('ownership'));
}, 30_000);

test('a busy watchdog lock never reaches send and stays retryable', async () => {
	let sends = 0;
	await lockBusy(() => sends++);
	expect(sends).toBe(0);
	const value = await semantic('lock-busy');
	expect(value.state).toBe('not-sent');
	expect(value.retryScheduled).toBe(true);
}, 30_000);

test('a generic send error after input starts is uncertain and never retried', async () => {
	const result = await deliverWakeParts(
		'alpha',
		'after-input',
		[notice('after-input')],
		() => Promise.reject(new Error('provider failure')),
		() => Promise.resolve(true),
	);
	expect(result).toBe('uncertain');
	const value = await semantic('after-input');
	expect(value.state).toBe('uncertain');
	expect(value.retryScheduled).toBe(false);
});
