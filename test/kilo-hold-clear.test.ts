import { afterEach, beforeEach, expect, test } from 'bun:test';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { checkpointHash } from '../src/checkpoint-package-model.ts';
import { deliveryView, noticesHeldPrefix, saveDelivery } from '../src/mail-session.ts';
import { createWakeCoordinator } from '../src/wake-coordinator.ts';
import { saveWakeOutcome } from '../src/wake-delivery-store.ts';
import { recoverWakeError, retainWakeError } from '../src/wake-errors.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

// Roger L2 and Morticia's Low on 4283a53 (#22239, #22240; Morgan 9a4f103e): a Kilo hold carries any
// problem the retained records still report, and clearing it returns to that problem, not to
// readiness alone. Order as the final save: inventory, unsent, uncertain, then readiness.

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const oldHome = process.env.SUMMON_HOME;
const oldNonce = process.env.SUMMON_NONCE;
const nonce = 'clear-kilo';
const lost = `${noticesHeldPrefix}alpha launch ${nonce}: no Kilo turn stream is attached.`;
const unsent = 'A notification remains unsent';
const uncertain = 'Provider input may have begun';
const inventory = 'Notification inventory could not be read';
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_NONCE = nonce;
	await initializeActivity('alpha', nonce);
	await saveDelivery('alpha', {
		nonce,
		thread: 'ses_exact',
		pid: process.pid,
		state: 'live',
		reason: "Model confirmed receipt of this launch's notification.",
	});
});
afterEach(async () => {
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	if (oldNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = oldNonce;
	await fixture.dispose();
});

async function retained(state: 'not-sent' | 'uncertain' | 'attempted' | 'acknowledged') {
	const targets = [{ source: 'readiness' as const, key: nonce, through: 0, ids: [] }];
	const now = new Date().toISOString();
	await saveWakeOutcome({
		version: 1,
		owner: 'alpha',
		nonce,
		id: checkpointHash(['alpha', nonce, targets]),
		targets,
		state,
		stage: 'notification delivery',
		attempts: 1,
		retryAt: 0,
		createdAt: now,
		updatedAt: now,
	});
}
/** One cycle with the notice gate closed: `hold` is the receiver's answer (a reason, null, or undefined). */
async function gatedCycle(hold: string | null | undefined): Promise<void> {
	await createWakeCoordinator(
		'alpha',
		nonce,
		() => Promise.resolve(),
		() => true,
		() => Promise.resolve(true),
		{ noticeAllowed: () => Promise.resolve(false), noticeHold: () => Promise.resolve(hold) },
	)();
}
const status = () => deliveryView('alpha');

test.each([
	['not-sent', unsent],
	['uncertain', uncertain],
	['attempted', uncertain],
] as const)(
	'unresolved %s, then loss, then busy: the problem survives both',
	async (state, text) => {
		await retained(state);
		await gatedCycle(lost);
		expect((await status()).state).toBe('queued-only');
		expect((await status()).reason.startsWith(`${lost} ${text}`)).toBe(true);
		await gatedCycle(null);
		expect((await status()).state).toBe('queued-only');
		expect((await status()).reason.startsWith(text)).toBe(true);
	},
);

test('a current inventory error survives loss and busy, and recovery ends it', async () => {
	await retainWakeError('alpha', 'mail inventory', new Error('PRIVATE_DETAIL'));
	await retained('not-sent');
	await gatedCycle(lost);
	const heldReason = (await status()).reason;
	expect(heldReason.startsWith(lost)).toBe(true);
	expect(heldReason).toContain(inventory);
	expect(heldReason).not.toContain(unsent);
	expect(heldReason).not.toContain('PRIVATE');
	await gatedCycle(null);
	expect((await status()).reason.startsWith(inventory)).toBe(true);
	await recoverWakeError('alpha', 'mail inventory');
	await retained('acknowledged');
	await gatedCycle(lost);
	expect((await status()).reason).toBe(lost);
	await gatedCycle(null);
	expect((await status()).state).toBe('unconfirmed');
	expect((await status()).reason.startsWith(noticesHeldPrefix)).toBe(false);
});

test('an episode from another launch does not count', async () => {
	await initializeActivity('alpha', 'earlier-launch');
	await retainWakeError('alpha', 'room inventory', new Error('old'));
	await initializeActivity('alpha', nonce);
	await gatedCycle(lost);
	expect((await status()).reason).toBe(lost);
});

test('with nothing retained, clearing returns to readiness; no hold, or not ours, writes nothing', async () => {
	await gatedCycle(lost);
	expect((await status()).reason).toBe(lost);
	const path = join(fixture.records, 'runtime/alpha', `${nonce}.json`);
	const written = (await stat(path)).mtimeMs;
	await Bun.sleep(30);
	await gatedCycle(lost);
	await gatedCycle(undefined);
	expect((await stat(path)).mtimeMs).toBe(written);
	await gatedCycle(null);
	expect((await status()).state).toBe('unconfirmed');
	const cleared = (await stat(path)).mtimeMs;
	await Bun.sleep(30);
	await gatedCycle(null);
	expect((await stat(path)).mtimeMs).toBe(cleared);
});
