import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { checkpoint } from '../src/checkpoint.ts';
import { optionalText } from '../src/mail-files.ts';
import { header, readOwnChunk, recordRead, statePath } from '../src/mail-read.ts';
import { deliveryStatus } from '../src/mail-session.ts';
import { acknowledgeMessage, pendingMessages, sendMessage } from '../src/mailbox.ts';
import { NotificationNotSentError } from '../src/notification-delivery.ts';
import { wakeErrors } from '../src/wake-errors.ts';
import { coalesceReceiver, releaseFixtureReceiver } from './fixtures/coalesce-receiver.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

// #24276, mail source. The hold rests on source (a notice per new id regardless of an unread
// earlier one); the export could not pair mail submissions with deliveries one to one.

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const nonce = 'mail-launch';
const saved = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
};
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = nonce;
});
afterEach(async () => {
	await releaseFixtureReceiver();
	if (saved.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = saved.home;
	if (saved.agent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = saved.agent;
	if (saved.nonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = saved.nonce;
	await fixture.dispose();
});
const on = { coalesceQueuedNotices: true };
const events = (count: number) => `summon: ${count} new mailbox event(s) for alpha.`;
/** Exactly one submitted notice, and it is the mail notice expected. */
function onlyNotice(sent: string[], text: string): void {
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain(text);
}
const request = (text: string) => sendMessage('alpha', 'alpha', text);
const read = async (id: string) => recordRead('alpha', await header('alpha', id));
const isRead = async (id: string) => !!(await optionalText(statePath('alpha', id, 'read')));

test('reading the queued mail, without archiving it, releases the hold', async () => {
	const { cycle, sent } = await coalesceReceiver(nonce, on);
	const first = await request('First request.');
	await cycle();
	onlyNotice(sent, events(1));
	await request('Second request, while the first is still queued.');
	await cycle();
	expect(sent).toHaveLength(1);
	await read(first);
	await cycle();
	expect(sent).toHaveLength(2);
	expect(sent[1]).toContain(events(1));
	// Read is the release; archiving or handling was never required.
	expect(await pendingMessages('alpha')).toContain(`${first}.md`);
});

test('with several queued ids the hold lasts until every one is read', async () => {
	const { cycle, sent } = await coalesceReceiver(nonce, on);
	const first = await request('First.');
	const second = await request('Second.');
	await cycle();
	onlyNotice(sent, events(2));
	await request('Third, while both are queued.');
	await read(first);
	await cycle();
	expect(sent).toHaveLength(1);
	await read(second);
	await cycle();
	expect(sent).toHaveLength(2);
	expect(sent[1]).toContain(events(1));
});

test('a partial body read does not release; finishing the body does', async () => {
	const { cycle, sent } = await coalesceReceiver(nonce, on);
	const long = await request('A long request. '.repeat(400));
	await cycle();
	await request('Second, while the long one is half read.');
	const { size } = await header('alpha', long);
	await readOwnChunk('alpha', long, 0, 512);
	await cycle();
	expect(await isRead(long)).toBe(false);
	expect(sent).toHaveLength(1);
	const rest = await readOwnChunk('alpha', long, 512, size);
	expect(rest.end).toBe(size);
	await cycle();
	expect(sent).toHaveLength(2);
});

test('an unreadable recorded header is a visible mail inventory failure, not a delivery', async () => {
	const { cycle, sent } = await coalesceReceiver(nonce, on);
	const first = await request('First.');
	await cycle();
	await request('Second.');
	// Not missing, so awaitsRead rethrows: the collector fails, every cycle, until it reads again.
	// Corrupt in place: a Windows reader can deny replacement while still permitting writes.
	await writeFile(join(fixture.records, 'mailboxes/alpha/inbox', `${first}.md`), 'damaged');
	await rejects(header('alpha', first), /Malformed message header/);
	await cycle();
	await cycle();
	expect(sent).toHaveLength(1);
	expect((await wakeErrors('alpha')).map((episode) => episode.stage)).toContain('mail inventory');
	expect((await deliveryStatus('alpha', nonce)).state).toBe('queued-only');
});

test('archiving releases the hold too', async () => {
	const { cycle, sent } = await coalesceReceiver(nonce, on);
	const first = await request('First.');
	await cycle();
	await request('Second.');
	await cycle();
	expect(sent).toHaveLength(1);
	await acknowledgeMessage('alpha', first);
	await cycle();
	expect(sent).toHaveLength(2);
});

test('the active checkpoint package releases without marking anything read', async () => {
	const { cycle, sent } = await coalesceReceiver(nonce, on);
	const first = await request('First.');
	await cycle();
	const inside = await request('Inside the package.');
	// Held first, so the release below is the package's doing, not the absence of a hold.
	await cycle();
	expect(sent).toHaveLength(1);
	await checkpoint();
	await cycle();
	expect(sent).toHaveLength(1);
	expect(await isRead(first)).toBe(false);
	expect(await isRead(inside)).toBe(false);
	await request('After the package was frozen.');
	await cycle();
	expect(sent).toHaveLength(2);
	expect(sent[1]).toContain(events(1));
});

test('a queued generated notice that becomes obsolete releases; requests keep their meaning', async () => {
	const confirmation = randomUUID();
	const restPath = join(fixture.records, 'runtime/alpha/rest.json');
	// The rest schema requires every field, reason included, on each write (as system-mail.test).
	const rest = {
		id: confirmation,
		mode: 'awake',
		board: '',
		through: 0,
		nonce,
		resume: false,
		reason: 'Fixture wake completed',
	};
	await Bun.write(restPath, JSON.stringify(rest));
	const { cycle, sent } = await coalesceReceiver(nonce, on);
	await sendMessage('alpha', 'alpha', 'Rest ended fixture', {
		system: {
			purpose: 'rest-ended',
			nonce,
			confirmation,
			previousActivityNonce: 'earlier-launch',
		},
	});
	await cycle();
	expect(sent).toHaveLength(1);
	const ask = await request('A real request after it.');
	await cycle();
	expect(sent).toHaveLength(1);
	await Bun.write(restPath, JSON.stringify({ ...rest, id: randomUUID(), mode: 'ready' }));
	await cycle();
	expect(sent).toHaveLength(2);
	expect(sent[1]).toContain(events(1));
	expect((await header('alpha', ask)).kind).toBe('request');
	expect(await isRead(ask)).toBe(false);
});

test('an uncertain mail submission takes no hold and is not replayed', async () => {
	let failOnce = true;
	const { cycle, sent } = await coalesceReceiver(nonce, on, {
		fail: () => {
			if (!failOnce) return undefined;
			failOnce = false;
			return new Error('provider closed mid-write');
		},
	});
	await request('First.');
	await cycle();
	expect(sent).toHaveLength(0);
	await request('Second.');
	await cycle();
	// Only the new id: the uncertain one stays seen and is never sent again.
	onlyNotice(sent, events(1));
});

test('a definitely unsent mail notice takes no hold; its id rides the next attempt', async () => {
	let failOnce = true;
	const { cycle, sent } = await coalesceReceiver(nonce, on, {
		fail: () => {
			if (!failOnce) return undefined;
			failOnce = false;
			return new NotificationNotSentError('terminal unavailable');
		},
	});
	await request('First.');
	await cycle();
	expect(sent).toHaveLength(0);
	await request('Second.');
	await cycle();
	onlyNotice(sent, events(2));
});

test('a queued mail notice of one launch does not hold another launch', async () => {
	const first = await coalesceReceiver(nonce, on);
	await request('First.');
	await first.cycle();
	process.env.SUMMON_NONCE = 'mail-launch-two';
	const second = await coalesceReceiver('mail-launch-two', on);
	await second.cycle();
	onlyNotice(second.sent, events(1));
});

test('without the option each new mail id is submitted, as today', async () => {
	const { cycle, sent } = await coalesceReceiver(nonce, {});
	await request('First.');
	await cycle();
	await request('Second.');
	await cycle();
	expect(sent).toHaveLength(2);
});
