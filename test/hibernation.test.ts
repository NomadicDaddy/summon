import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { recoverMissedMentionWakes } from '../src/desktop/mention-recovery.ts';
import { queueMentionWake, readPendingMentionWake } from '../src/desktop/mention-wakes.ts';
import {
	deliverHibernationControl,
	humanHibernationCommand,
	isHibernated,
	setHibernation,
} from '../src/hibernation.ts';
import { sendHuman } from '../src/local-room-access.ts';
import { optionalText } from '../src/mail-files.ts';
import { startMailWatcher } from '../src/mail-watcher.ts';
import { sendMessage } from '../src/mailbox.ts';
import { NotificationNotSentError } from '../src/notification-delivery.ts';
import { acquireSessionLock, isAgentRunning, type SessionLock } from '../src/session-lock.ts';
import { loadAgent, saveAgent } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const original = process.env.SUMMON_HOME;
let lock: SessionLock | undefined;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	await lock?.release();
	lock = undefined;
	if (original === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = original;
	await fixture.dispose();
});

test('only operator controls persist hibernation; stale saves retain it and the session lock', async () => {
	const stale = await loadAgent('alpha');
	if (!stale) throw new Error('Missing fixture');
	lock = await acquireSessionLock('alpha');
	expect((await fixture.run(['--hibernate', 'alpha'])).code).toBe(0);
	expect(await isHibernated('alpha')).toBe(true);
	for (const command of ['--hibernate', '--unhibernate']) {
		expect((await fixture.run([command, 'alpha'], 'alpha')).code).toBe(1);
		expect((await fixture.run([command, 'alpha'], 'beta')).code).toBe(1);
	}
	await saveAgent('alpha', stale);
	expect(await isHibernated('alpha')).toBe(true);
	expect(await isAgentRunning('alpha')).toBe(true);
	expect((await fixture.run(['alpha', '--same-window'])).error).toContain('hibernated');
	await sendHuman('@alpha --unhibernate');
	expect(await isHibernated('alpha')).toBe(false);
	expect(await isAgentRunning('alpha')).toBe(true);
});

test('peer room text and quoted prose cannot release; stale transport controls cannot reverse a decision', async () => {
	await sendHuman('--hibernate alpha');
	expect((await fixture.run(['--room', 'send', '@alpha --unhibernate'], 'beta')).code).toBe(0);
	expect(await isHibernated('alpha')).toBe(true);
	expect(await humanHibernationCommand('please use @alpha --unhibernate')).toBe(false);
	await humanHibernationCommand('@alpha --unhibernate', Date.now() - 10000);
	expect(await isHibernated('alpha')).toBe(true);
	await setHibernation('alpha', false);
	await humanHibernationCommand('@alpha --hibernate', Date.now() - 10000);
	expect(await isHibernated('alpha')).toBe(false);
});

test('hibernation control is delivered once per transition without routine startup notices', async () => {
	const sent: string[] = [];
	const send = (text: string) => {
		sent.push(text);
		return Promise.resolve();
	};
	await setHibernation('alpha', true);
	expect(await deliverHibernationControl('alpha', 'fixture-launch', send)).toBe(true);
	expect(await deliverHibernationControl('alpha', 'fixture-launch', send)).toBe(true);
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain('Wrap up safely');
	await setHibernation('alpha', false);
	expect(await deliverHibernationControl('alpha', 'fixture-launch', send)).toBe(false);
	expect(sent).toHaveLength(2);
	expect(sent[1]).toContain('unhibernated');
});

test('definite pre-send failure restores the previous control revision and retries once', async () => {
	const path = join(fixture.records, 'runtime/alpha/retry-control.hibernation-control');
	await setHibernation('alpha', true);
	const sent: string[] = [];
	const send = (text: string): Promise<void> => {
		sent.push(text);
		return Promise.resolve();
	};
	await deliverHibernationControl('alpha', 'retry-control', send);
	const previous = await optionalText(path);
	await setHibernation('alpha', false);
	const failure: unknown = await deliverHibernationControl('alpha', 'retry-control', () =>
		Promise.reject(new NotificationNotSentError('human draft')),
	).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(NotificationNotSentError);
	expect(await optionalText(path)).toBe(previous);
	await deliverHibernationControl('alpha', 'retry-control', send);
	await deliverHibernationControl('alpha', 'retry-control', send);
	expect(sent).toHaveLength(2);
	expect(sent[1]).toContain('unhibernated');
});

test('uncertain control failure keeps its marker and never automatically repeats that revision', async () => {
	await setHibernation('alpha', true);
	let attempts = 0;
	const send = (): Promise<void> => {
		attempts++;
		return Promise.reject(new Error('provider acknowledgment unavailable'));
	};
	const failure: unknown = await deliverHibernationControl(
		'alpha',
		'uncertain-control',
		send,
	).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(Error);
	expect(await deliverHibernationControl('alpha', 'uncertain-control', send)).toBe(true);
	expect(attempts).toBe(1);
});

test('checkpoint does not acknowledge retained receipts while hibernated and resumes pending messages', async () => {
	await sendHuman('first unread');
	const first = JSON.parse((await fixture.run(['--checkpoint'], 'alpha')).out) as {
		receipt: string;
	};
	await setHibernation('alpha', true);
	await sendHuman('pending during hibernation');
	const paused = JSON.parse(
		(await fixture.run(['--checkpoint', first.receipt], 'alpha')).out,
	) as { hibernated: boolean; receipt?: string };
	expect(paused.hibernated).toBe(true);
	expect(paused.receipt).toBeUndefined();
	await setHibernation('alpha', false);
	const final = JSON.parse((await fixture.run(['--checkpoint', first.receipt], 'alpha')).out) as {
		receipt: string;
	};
	const resumed = JSON.parse(
		(await fixture.run(['--checkpoint', final.receipt], 'alpha')).out,
	) as { room: { events: { text: string }[] } };
	expect(resumed.room.events.map((event) => event.text)).toEqual(['pending during hibernation']);
});

test('live receiver with unread mail and room traffic delivers only control until release', async () => {
	await sendMessage('beta', 'alpha', 'pending mail');
	await sendHuman('@alpha pending room');
	await setHibernation('alpha', true);
	const sent: string[] = [];
	const stop = await startMailWatcher('alpha', 'fixture-receiver', (text) => {
		sent.push(text);
		return Promise.resolve();
	});
	try {
		await Bun.sleep(2500);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain('hibernated');
		await setHibernation('alpha', false);
		await Bun.sleep(2500);
		expect(sent.some((text) => text.includes('unhibernated'))).toBe(true);
		expect(sent.some((text) => text.includes('mailbox readiness'))).toBe(true);
	} finally {
		await stop();
	}
}, 10000);

test('startup recovery preserves an unread mention and pending wake until operator release', async () => {
	const record = await loadAgent('alpha');
	if (!record) throw new Error('Missing fixture');
	record.provider = 'grok';
	await saveAgent('alpha', record);
	const event = await sendHuman('@alpha assigned work');
	await queueMentionWake('alpha', event.id);
	await setHibernation('alpha', true);
	const started: string[] = [];
	const skipped: string[] = [];
	const start = (slug: string) => {
		started.push(slug);
		return Promise.resolve();
	};
	const since = new Date(Date.now() - 10000).toISOString();
	await recoverMissedMentionWakes(
		[event],
		since,
		() => false,
		start,
		(slug) => {
			skipped.push(slug);
		},
	);
	expect(started).toEqual([]);
	expect(skipped).toEqual(['alpha']);
	expect((await readPendingMentionWake('alpha'))?.through).toBe(event.id);
	await setHibernation('alpha', false);
	await recoverMissedMentionWakes([event], since, () => false, start);
	expect(started).toEqual(['alpha']);
});
