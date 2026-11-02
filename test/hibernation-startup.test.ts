import { afterEach, beforeEach, expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { deliverHibernationControl, setHibernation } from '../src/hibernation.ts';
import { pendingMessages, sendMessage } from '../src/mailbox.ts';
import { NotificationNotSentError } from '../src/notification-delivery.ts';
import { readRest } from '../src/rest.ts';
import { createWakeCoordinator } from '../src/wake-coordinator.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

test('new launches do not replay an already inactive hibernation decision', async () => {
	await setHibernation('alpha', true);
	await setHibernation('alpha', false);
	const sent: string[] = [];
	const send = (text: string): Promise<void> => {
		sent.push(text);
		return Promise.resolve();
	};
	for (const nonce of ['first-launch', 'resumed-launch']) {
		expect(await deliverHibernationControl('alpha', nonce, send)).toBe(false);
		expect(await deliverHibernationControl('alpha', nonce, send)).toBe(false);
	}
	expect(sent).toEqual([]);
	// A subsequent operator transition still controls this receiver exactly once.
	await setHibernation('alpha', true);
	expect(await deliverHibernationControl('alpha', 'resumed-launch', send)).toBe(true);
	expect(await deliverHibernationControl('alpha', 'resumed-launch', send)).toBe(true);
	await setHibernation('alpha', false);
	expect(await deliverHibernationControl('alpha', 'resumed-launch', send)).toBe(false);
	expect(await deliverHibernationControl('alpha', 'resumed-launch', send)).toBe(false);
	expect(sent).toHaveLength(2);
	expect(sent[0]).toContain('Wrap up safely');
	expect(sent[1]).toContain('has unhibernated');
});

test('a delivered hibernate is released once across launches, without later replay', async () => {
	const sent: string[] = [];
	const send = (text: string) => {
		sent.push(text);
		return Promise.resolve();
	};
	await setHibernation('alpha', true);
	await deliverHibernationControl('alpha', 'old-launch', send);
	await setHibernation('alpha', false);
	await deliverHibernationControl('alpha', 'resumed-launch', send);
	await deliverHibernationControl('alpha', 'resumed-launch', send);
	await deliverHibernationControl('alpha', 'later-launch', send);
	expect(sent).toHaveLength(2);
	expect(sent[0]).toContain('Wrap up safely');
	expect(sent[1]).toContain('has unhibernated');
});

test('cross-launch release retries only definite failures and retains uncertain attempts', async () => {
	await setHibernation('alpha', true);
	await deliverHibernationControl('alpha', 'old-launch', async () => {});
	await setHibernation('alpha', false);
	const failed = await deliverHibernationControl('alpha', 'failed-launch', () =>
		Promise.reject(new NotificationNotSentError('not submitted')),
	).catch((error: unknown) => error);
	expect(failed).toBeInstanceOf(NotificationNotSentError);
	let attempts = 0;
	const uncertain = await deliverHibernationControl('alpha', 'retry-launch', () => {
		attempts++;
		return Promise.reject(new Error('uncertain'));
	}).catch((error: unknown) => error);
	expect(uncertain).toBeInstanceOf(Error);
	await deliverHibernationControl('alpha', 'later-launch', () => {
		attempts++;
		return Promise.resolve();
	});
	expect(attempts).toBe(1);
});

test('replacement receivers cannot both claim the same owed release', async () => {
	await setHibernation('alpha', true);
	await deliverHibernationControl('alpha', 'old-launch', async () => {});
	await setHibernation('alpha', false);
	const sent: string[] = [];
	await Promise.all(
		['replacement-one', 'replacement-two'].map((nonce) =>
			deliverHibernationControl('alpha', nonce, (text) => {
				sent.push(text);
				return Promise.resolve();
			}),
		),
	);
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain('has unhibernated');
});

test('an unheard stopped cycle does not replay a release from earlier control history', async () => {
	const sent: string[] = [];
	const send = (text: string) => {
		sent.push(text);
		return Promise.resolve();
	};
	await setHibernation('alpha', true);
	await deliverHibernationControl('alpha', 'old-launch', send);
	await setHibernation('alpha', false);
	await deliverHibernationControl('alpha', 'old-launch', send);
	await setHibernation('alpha', true);
	await setHibernation('alpha', false);
	await setHibernation('alpha', false);
	await deliverHibernationControl('alpha', 'old-launch', send);
	await deliverHibernationControl('alpha', 'next-launch', send);
	expect(sent).toHaveLength(2);
});

test('older retained revision markers remain conservatively deliverable once', async () => {
	const sent: string[] = [];
	const send = (text: string) => {
		sent.push(text);
		return Promise.resolve();
	};
	await setHibernation('alpha', true);
	await deliverHibernationControl('alpha', 'old-launch', send);
	await setHibernation('alpha', false);
	await unlink(join(fixture.records, 'runtime/alpha/hibernation-last-control'));
	await deliverHibernationControl('alpha', 'next-launch', send);
	await deliverHibernationControl('alpha', 'later-launch', send);
	expect(sent).toHaveLength(2);
	expect(sent[1]).toContain('has unhibernated');
});

test.each(['old-launch', 'replacement-launch'])(
	'an owed release survives multiple unheard transitions before %s resumes',
	async (nonce) => {
		const sent: string[] = [];
		const send = (text: string) => {
			sent.push(text);
			return Promise.resolve();
		};
		await setHibernation('alpha', true);
		await deliverHibernationControl('alpha', 'old-launch', send);
		await setHibernation('alpha', false);
		await setHibernation('alpha', true);
		await setHibernation('alpha', false);
		await deliverHibernationControl('alpha', nonce, send);
		await deliverHibernationControl('alpha', 'later-launch', send);
		expect(sent).toHaveLength(2);
		expect(sent[1]).toContain('has unhibernated');
	},
);

test('a corrupt last control cannot silently discard an owed release', async () => {
	await setHibernation('alpha', true);
	await deliverHibernationControl('alpha', 'old-launch', async () => {});
	await setHibernation('alpha', false);
	await Bun.write(join(fixture.records, 'runtime/alpha/hibernation-last-control'), 'unknown');
	let sent = false;
	const error: unknown = await deliverHibernationControl('alpha', 'next-launch', () => {
		sent = true;
		return Promise.resolve();
	}).catch((error: unknown) => error);
	expect(error).toBeInstanceOf(Error);
	expect(String(error)).toContain('Invalid last hibernation control');
	expect(sent).toBe(false);
});

test('a historical release cannot bypass rest; genuinely new mail still wakes', async () => {
	await setHibernation('alpha', true);
	await setHibernation('alpha', false);
	await initializeActivity('alpha', 'test-launch');
	await Bun.write(join(fixture.records, 'runtime/alpha/test-launch.ready'), 'test-launch');
	const ready = await fixture.run(['--rest', 'ready'], 'alpha');
	expect(ready.code).toBe(0);
	expect((await readRest('alpha'))?.mode).toBe('ready');
	const sent: string[] = [];
	const tick = createWakeCoordinator(
		'alpha',
		'test-launch',
		(text) => {
			sent.push(text);
			return Promise.resolve();
		},
		() => true,
		() => Promise.resolve(true),
		{},
	);
	await tick();
	await tick();
	expect(sent).toEqual([]);
	expect((await readRest('alpha'))?.mode).toBe('ready');
	await sendMessage('beta', 'alpha', 'New authorized-work fixture');
	await tick();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain('1 new mailbox event');
	expect(sent[0]).not.toContain('has unhibernated');
	expect((await readRest('alpha'))?.mode).toBe('wake-requested');
	expect(await pendingMessages('alpha')).toHaveLength(1);
});
