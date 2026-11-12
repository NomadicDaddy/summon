import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { NotificationNotSentError } from '../src/notification-delivery.ts';
import { recoverWakeError, retainWakeError, wakeErrors } from '../src/wake-errors.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
async function rejection(action: Promise<unknown>): Promise<string> {
	const result: unknown = await action.catch((error: unknown) => error);
	expect(result).toBeInstanceOf(Error);
	return result instanceof Error ? result.message : 'Expected an error';
}
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

// Four serialized persistence attempts and two new CLI processes must finish even when another
// gate is running. The budget bounds the fixture; it is not a mailbox latency assertion.
test('concurrent failures persist once, survive a new reader, and keep raw errors private', async () => {
	await initializeActivity('alpha', 'first-launch');
	const results = await Promise.all(
		Array.from({ length: 4 }, () =>
			retainWakeError(
				'alpha',
				'pending wake',
				new NotificationNotSentError('PRIVATE_SENTINEL'),
				9,
			),
		),
	);
	expect(results.filter((result) => result.changed)).toHaveLength(1);
	const stored = await wakeErrors('alpha');
	expect(stored).toHaveLength(1);
	expect(stored[0]?.observedNonce).toBe('first-launch');
	expect(stored[0]?.roomThrough).toBe(9);
	expect(stored[0]?.certainty).toBe('not-sent');
	const status = await fixture.run(['--mail', 'status'], 'alpha', {
		SUMMON_NONCE: 'first-launch',
	});
	expect(status.code).toBe(0);
	expect(status.out).toContain(results[0]?.episode.id ?? 'missing-id');
	expect(status.out).not.toContain('PRIVATE_SENTINEL');
	const other = await fixture.run(['--mail', 'status'], 'beta');
	expect(other.code).toBe(0);
	expect(other.out).toContain('"wakeErrors":[]');
	const id = stored[0]?.id;
	if (!id) throw new Error('Expected persisted episode.');
	expect(
		await readFile(join(fixture.records, 'runtime/alpha/wake-errors', `${id}.json`), 'utf8'),
	).not.toContain('PRIVATE_SENTINEL');
}, 30_000);

test('recovery preserves the failure identity and later failures retain separate history', async () => {
	await rm(join(fixture.records, 'runtime/alpha/activity.json'));
	const first = await retainWakeError('alpha', 'mention wake', new Error('opaque'), 7);
	expect(first.episode.observedNonce).toBeNull();
	expect(first.episode.certainty).toBe('uncertain');
	await initializeActivity('alpha', 'recovery-launch');
	await recoverWakeError('alpha', 'mention wake');
	const recovered = (await wakeErrors('alpha'))[0];
	expect(recovered?.id).toBe(first.episode.id);
	expect(recovered?.failedAt).toBe(first.episode.failedAt);
	expect(recovered?.recoveredAt).toBeDefined();
	expect(recovered?.recoveredByNonce).toBe('recovery-launch');
	const retained = await readFile(
		join(fixture.records, 'runtime/alpha/wake-errors', `${first.episode.id}.json`),
		'utf8',
	);
	const second = await retainWakeError('alpha', 'mention wake', new Error('opaque'), 8);
	expect(second.episode.id).not.toBe(first.episode.id);
	expect(second.episode.roomThrough).toBe(8);
	expect(
		await readFile(
			join(fixture.records, 'runtime/alpha/wake-errors', `${first.episode.id}.json`),
			'utf8',
		),
	).toBe(retained);
});

test('an unknown owner, corrupt index or mismatched episode fails closed without leaking content', async () => {
	const originalAgent = process.env.SUMMON_AGENT;
	const originalNonce = process.env.SUMMON_NONCE;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = 'test-launch';
	try {
		expect(await rejection(wakeErrors('beta'))).toContain('own');
	} finally {
		if (originalAgent === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = originalAgent;
		if (originalNonce === undefined) delete process.env.SUMMON_NONCE;
		else process.env.SUMMON_NONCE = originalNonce;
	}
	const root = join(fixture.records, 'runtime/alpha');
	await mkdir(root, { recursive: true });
	await writeFile(join(root, 'wake-errors.json'), '{"PRIVATE_SENTINEL":true}');
	expect(await rejection(wakeErrors('alpha'))).toContain('Invalid wake error index');
	await writeFile(join(root, 'wake-errors.json'), '{}');
	const result = await retainWakeError('alpha', 'rest wake', new Error('opaque'));
	await writeFile(
		join(root, 'wake-errors', `${result.episode.id}.json`),
		JSON.stringify({ ...result.episode, owner: 'beta' }),
	);
	expect(await rejection(recoverWakeError('alpha', 'rest wake'))).toContain(
		'Invalid wake error episode',
	);
	await writeFile(
		join(root, 'wake-errors', `${result.episode.id}.json`),
		JSON.stringify({ ...result.episode, stage: 'pending wake' }),
	);
	expect(await rejection(recoverWakeError('alpha', 'rest wake'))).toContain(
		'Invalid wake error episode',
	);
	const status = await fixture.run(['--mail', 'status'], 'alpha');
	expect(status.code).toBe(1);
	expect(status.error).toContain('Invalid wake error episode');
	expect(status.error).not.toContain('PRIVATE_SENTINEL');
});
