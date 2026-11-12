import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { atomicWrite } from '../src/mail-files.ts';
import { responseFailure } from '../src/response-watchdog-errors.ts';
import { trackResponseSafely } from '../src/response-watchdog-safety.ts';
import { responseStatusView } from '../src/response-watchdog-store.ts';
import { wakeErrors } from '../src/wake-errors.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await initializeActivity('alpha', 'failure-launch');
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});
const fail = () => trackResponseSafely('alpha', () => Promise.reject(new Error('private body')));

test('failures deduplicate, recover explicitly and preserve earlier episodes', async () => {
	await fail();
	const first = await responseFailure('alpha');
	expect(first).not.toBeNull();
	await fail();
	expect(await responseFailure('alpha')).toEqual(first);
	expect(JSON.stringify(first)).not.toContain('private body');
	expect((await responseStatusView('alpha', 'failure-launch')).responseWatchdogError).toContain(
		'unavailable',
	);
	expect(await wakeErrors('alpha')).toEqual([]);
	expect(await Bun.file(join(fixture.records, 'runtime/alpha/wake-errors.json')).exists()).toBe(
		false,
	);
	await trackResponseSafely('alpha', () => Promise.resolve());
	expect((await responseFailure('alpha'))?.recoveredAt).toBeUndefined();
	await trackResponseSafely('alpha', () => Promise.resolve(), true);
	const recovered = await responseFailure('alpha');
	expect(recovered?.recoveredAt).toBeDefined();
	expect(
		(await responseStatusView('alpha', 'failure-launch')).responseWatchdogError,
	).toBeUndefined();
	await fail();
	expect((await responseFailure('alpha'))?.id).not.toBe(first?.id);
	expect(
		await Bun.file(
			join(fixture.records, 'runtime/alpha/response-watchdog-errors', `${first?.id}.json`),
		).json(),
	).toEqual(recovered);
});

test('corrupt diagnostic remains untouched and cannot hide mail status or authorize retry', async () => {
	const path = join(fixture.records, 'runtime/alpha/response-watchdog-errors.json');
	await atomicWrite(path, 'broken');
	await fail();
	await trackResponseSafely('alpha', () => Promise.resolve(), true);
	expect(await Bun.file(path).text()).toBe('broken');
	const status = await fixture.run(['--mail', 'status'], 'alpha', {
		SUMMON_NONCE: 'failure-launch',
	});
	expect(status.code).toBe(0);
	expect(status.out).toContain('Delivery response diagnostic unavailable');
	expect(await wakeErrors('alpha')).toEqual([]);
});
