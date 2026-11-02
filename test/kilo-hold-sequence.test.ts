import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { checkpointHash } from '../src/checkpoint-package-model.ts';
import {
	initializeKiloTurn,
	invalidateKiloTurn,
	kiloNoticeAllowed,
	kiloNoticeHold,
	kiloStartupSettled,
	kiloStartupSubmitting,
	observeKiloTurn,
} from '../src/kilo-turn-state.ts';
import { deliveryView, noticesHeldPrefix, saveDelivery } from '../src/mail-session.ts';
import { createWakeCoordinator } from '../src/wake-coordinator.ts';
import { saveWakeOutcome } from '../src/wake-delivery-store.ts';
import { wakeErrors } from '../src/wake-errors.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

// Morgan 9a4f103e and 716af1bd: the real turn-record sequence, an unresolved problem, then stream
// loss, reattach and busy, through the real Kilo predicate and hold. The problem must stay visible.

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const oldHome = process.env.SUMMON_HOME;
const oldNonce = process.env.SUMMON_NONCE;
const nonce = 'sequence-kilo';
const thread = 'ses_exact';
const prefix = `${noticesHeldPrefix}alpha launch ${nonce}:`;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_NONCE = nonce;
	await initializeActivity('alpha', nonce);
	await initializeKiloTurn('alpha', nonce, thread, 'stream-one');
	await kiloStartupSubmitting('alpha', nonce, thread);
	await kiloStartupSettled('alpha', nonce, thread, 'accepted');
	await native('busy');
	await native('idle');
});
afterEach(async () => {
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	if (oldNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = oldNonce;
	await fixture.dispose();
});

const native = (status: string, observer = 'stream-one') =>
	observeKiloTurn('alpha', nonce, observer, {
		type: 'session.status',
		properties: { sessionID: thread, status: { type: status } },
	});
const cycle = () =>
	createWakeCoordinator(
		'alpha',
		nonce,
		() => Promise.resolve(),
		() => true,
		() => Promise.resolve(true),
		{
			noticeAllowed: () => kiloNoticeAllowed('alpha', nonce),
			noticeHold: async () => (await kiloNoticeHold('alpha', nonce)) ?? null,
		},
	)();
const status = () => deliveryView('alpha');
/** Loss, then reattach on a new stream, then an observed busy: three gated cycles. */
async function lossReattachBusy(): Promise<string[]> {
	const seen: string[] = [];
	await invalidateKiloTurn('alpha', nonce, 'stream-one');
	await cycle();
	seen.push((await status()).reason);
	await initializeKiloTurn('alpha', nonce, thread, 'stream-two');
	await cycle();
	seen.push((await status()).reason);
	await native('busy', 'stream-two');
	await cycle();
	seen.push((await status()).reason);
	return seen;
}

test('an unresolved uncertain outcome survives loss, reattach and busy', async () => {
	const targets = [{ source: 'readiness' as const, key: nonce, through: 0, ids: [] }];
	const now = new Date().toISOString();
	await saveWakeOutcome({
		version: 1,
		owner: 'alpha',
		nonce,
		id: checkpointHash(['alpha', nonce, targets]),
		targets,
		state: 'uncertain',
		stage: 'notification delivery',
		attempts: 1,
		retryAt: 0,
		createdAt: now,
		updatedAt: now,
	});
	const uncertain =
		'Provider input may have begun; inspect the delivery outcome before retrying.';
	await saveDelivery('alpha', {
		nonce,
		thread,
		pid: process.pid,
		state: 'queued-only',
		reason: uncertain,
	});
	const [lost, waiting, busy] = await lossReattachBusy();
	expect(lost).toStartWith(`${prefix} no Kilo turn stream is attached`);
	expect(lost).toEndWith(uncertain);
	expect(waiting).toStartWith(`${prefix} waiting for an observed busy then idle`);
	expect(waiting).toEndWith(uncertain);
	expect(busy).toBe(uncertain);
	expect((await status()).state).toBe('queued-only');
});

test('a current Telegram inventory failure stays visible through the same sequence', async () => {
	await saveDelivery('alpha', {
		nonce,
		thread,
		pid: process.pid,
		state: 'live',
		reason: "Model confirmed receipt of this launch's notification.",
	});
	// An unreadable integration file fails the poll locally, with no network involved.
	await mkdir(join(fixture.records, 'integrations'), { recursive: true });
	await writeFile(join(fixture.records, 'integrations', 'telegram.json'), '{}');
	const inventory = 'Notification inventory could not be read';
	const [lost, waiting, busy] = await lossReattachBusy();
	expect(lost).toStartWith(prefix);
	expect(lost).toContain(inventory);
	expect(waiting).toContain(inventory);
	expect(busy).toStartWith(inventory);
	expect((await status()).state).toBe('queued-only');
	const episode = (await wakeErrors('alpha')).find(
		(value) => value.stage === 'telegram inventory',
	);
	expect(episode?.recoveredAt).toBeUndefined();
	// Removing the cause is not recovery: the episode stays until a real cycle succeeds.
	await rm(join(fixture.records, 'integrations', 'telegram.json'));
	await cycle();
	expect((await status()).reason).toStartWith(inventory);
});
