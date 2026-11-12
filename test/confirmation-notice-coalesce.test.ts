import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { Hold } from '../src/mail-attention.ts';

import { initializeActivity } from '../src/agent-activity.ts';
import { atomicWrite } from '../src/mail-files.ts';
import { header, recordRead } from '../src/mail-read.ts';
import { pendingMessages, sendMessage } from '../src/mailbox.ts';
import { coalesceReceiver, releaseFixtureReceiver } from './fixtures/coalesce-receiver.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

// The confirmation route through the real coordinator, delivery and Codex coalescing path, with a
// capturing sender in place of `codex queue`.

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const nonce = 'route-launch';
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
	await initializeActivity('alpha', nonce);
	await asBeta(() => initializeActivity('beta', nonce));
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
const CONFIRMATION_ROUTE =
	'summon: 1 new confirmation(s) for alpha. summon --current-requests leaves confirmations out; read them with summon --mail receive';
const read = async (id: string) => recordRead('alpha', await header('alpha', id));
/** Runs as beta: senders send only as themselves, and only beta may list beta's inbox. */
async function asBeta<T>(action: () => Promise<T>): Promise<T> {
	process.env.SUMMON_AGENT = 'beta';
	try {
		return await action();
	} finally {
		process.env.SUMMON_AGENT = 'alpha';
	}
}
const fromBeta = (text: string, kind?: 'confirmation') =>
	asBeta(() => sendMessage('beta', 'alpha', text, kind ? { kind } : {}));
const betaInbox = () => asBeta(() => pendingMessages('beta'));

test('a queued confirmation holds a later request until it is read, and reading it replies nothing', async () => {
	const { cycle, sent } = await coalesceReceiver(nonce, on);
	const confirmation = await fromBeta('Blocked on the slot.', 'confirmation');
	await cycle();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain(CONFIRMATION_ROUTE);
	await fromBeta('Please look at this.');
	await cycle();
	// Coalescing still applies: the queued confirmation is unread, so nothing more is submitted.
	expect(sent).toHaveLength(1);
	const before = await betaInbox();
	await read(confirmation);
	await cycle();
	expect(sent).toHaveLength(2);
	// The later request gets the ordinary focused-read notice, with no confirmation suffix.
	expect(sent[1]).toContain('summon: 1 new mailbox event(s) for alpha.');
	expect(sent[1]).not.toContain('confirmation');
	// Reading a confirmation is not a confirmation: nothing went back to its sender.
	expect(await betaInbox()).toEqual(before);
});

test('an approval decision and a confirmation in one wake keep both routes', async () => {
	const { cycle, sent } = await coalesceReceiver(nonce, on);
	await fromBeta('Done; no blocker.', 'confirmation');
	const hold: Hold = {
		id: randomUUID(),
		agent: 'alpha',
		messageId: randomUUID(),
		sender: 'beta',
		reason: 'Fixture reason',
		proposal: 'Fixture proposal',
		digest: 'fixture',
		createdAt: new Date().toISOString(),
		decision: 'approve',
		userReference: 'Disposable control only',
	};
	await atomicWrite(
		join(fixture.records, 'mailboxes/alpha/holds', `${hold.id}.json`),
		JSON.stringify(hold),
	);
	await cycle();
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain(CONFIRMATION_ROUTE);
	expect(sent[0]).toContain('summon: 1 approval decision(s) for alpha.');
	expect(sent[0]).toContain('summon --mail holds');
});
