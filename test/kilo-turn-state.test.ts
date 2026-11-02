import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
	initializeKiloTurn,
	invalidateKiloTurn,
	kiloInputSubmitted,
	kiloNoticeAllowed,
	kiloStartupSettled,
	kiloStartupSubmitting,
	kiloTurn,
	observeKiloTurn,
	reserveKiloNotice,
} from '../src/kilo-turn-state.ts';
import { markReady, saveDelivery } from '../src/mail-session.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const oldHome = process.env.SUMMON_HOME;
const oldNonce = process.env.SUMMON_NONCE;
const nonce = 'native-kilo';
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_NONCE = nonce;
	await initializeKiloTurn('alpha', nonce, 'ses_exact', 'connection-one');
	await saveDelivery('alpha', {
		nonce,
		thread: 'ses_exact',
		pid: process.pid,
		state: 'unconfirmed',
		reason: '',
	});
});
afterEach(async () => {
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	if (oldNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = oldNonce;
	await fixture.dispose();
});
const event = (status: string, sessionID = 'ses_exact', observer = 'connection-one') =>
	observeKiloTurn('alpha', nonce, observer, {
		type: 'session.status',
		properties: { sessionID, status: { type: status } },
		privateText: 'PRIVATE_SENTINEL',
	});

/** The startup turn submitted, accepted and observed to finish: the first point a notice may go. */
async function startupCompleted(): Promise<void> {
	await kiloStartupSubmitting('alpha', nonce, 'ses_exact');
	await kiloStartupSettled('alpha', nonce, 'ses_exact', 'accepted');
	await event('busy');
	await event('idle');
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(true);
}

test('receiver attachment preserves the outstanding turn and native observer', async () => {
	await startupCompleted();
	await reserveKiloNotice('alpha', nonce);
	const reserved = await kiloTurn('alpha', nonce);
	await initializeKiloTurn('alpha', nonce, 'ses_exact');
	expect(await kiloTurn('alpha', nonce)).toEqual(reserved);
	await event('busy');
	await event('idle');
	const completed = await kiloTurn('alpha', nonce);
	await initializeKiloTurn('alpha', nonce, 'ses_exact');
	expect(await kiloTurn('alpha', nonce)).toEqual(completed);
	expect(initializeKiloTurn('alpha', nonce, 'different')).rejects.toThrow('another thread');
});

test('no notice before the startup turn completes, even with readiness unconfirmed', async () => {
	// The removed pre-idle bootstrap allowed this; now an unobserved launch waits.
	await initializeKiloTurn('alpha', 'early-launch', 'ses_early');
	expect((await kiloTurn('alpha', 'early-launch'))?.observer).toBeNull();
	expect(await kiloNoticeAllowed('alpha', 'early-launch')).toBe(false);
	expect(reserveKiloNotice('alpha', 'early-launch')).rejects.toThrow('awaiting verified');
	await kiloStartupSubmitting('alpha', 'early-launch', 'ses_early');
	await kiloStartupSettled('alpha', 'early-launch', 'ses_early', 'accepted');
	expect(await kiloNoticeAllowed('alpha', 'early-launch')).toBe(false);
});

test('a completed startup and each later native busy/idle pair release exactly one wake', async () => {
	await startupCompleted();
	await reserveKiloNotice('alpha', nonce);
	await event('idle');
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(false);
	await event('busy');
	await event('idle');
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(true);
	await reserveKiloNotice('alpha', nonce);
	await event('idle');
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(false);
	await markReady('alpha', nonce);
	await event('busy');
	await event('idle');
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(true);
	expect(JSON.stringify(await kiloTurn('alpha', nonce))).not.toContain('PRIVATE');
});

test.each(['retry', 'offline', 'unknown'])('status %s is not completion', async (status) => {
	await startupCompleted();
	await reserveKiloNotice('alpha', nonce);
	await event(status);
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(false);
});

test('wrong session, replaced stream and disconnected stream cannot release a wake', async () => {
	await startupCompleted();
	await reserveKiloNotice('alpha', nonce);
	await event('busy', 'child-session');
	await event('idle', 'child-session');
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(false);
	await event('busy');
	await initializeKiloTurn('alpha', nonce, 'ses_exact', 'connection-two');
	await event('idle');
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(false);
	await event('busy', 'ses_exact', 'connection-two');
	await event('idle', 'ses_exact', 'connection-two');
	await invalidateKiloTurn('alpha', nonce, 'connection-one');
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(true);
	await invalidateKiloTurn('alpha', nonce, 'connection-two');
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(false);
});

test('human submit and newer native evidence defeat definite-unsent rollback', async () => {
	await startupCompleted();
	const rollback = await reserveKiloNotice('alpha', nonce);
	await rollback();
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(true);
	const older = await reserveKiloNotice('alpha', nonce);
	await kiloInputSubmitted('alpha', nonce);
	await older();
	await event('idle');
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(false);
	await event('busy');
	await event('idle');
	await kiloInputSubmitted('alpha', nonce);
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(false);
});

test('readiness alone, malformed events and corrupt persisted state never prove idle', async () => {
	await markReady('alpha', nonce);
	await observeKiloTurn('alpha', nonce, 'connection-one', {
		type: 'session.idle',
		properties: { sessionID: 'ses_exact' },
	});
	await observeKiloTurn('alpha', nonce, 'connection-one', {
		type: 'session.status',
		properties: [],
	});
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(false);
	expect(initializeKiloTurn('alpha', nonce, 'different', 'connection-two')).rejects.toThrow(
		'another thread',
	);
	await Bun.write(
		join(fixture.records, 'runtime/alpha/native-kilo.kilo-turn'),
		'PRIVATE_CORRUPT',
	);
	expect(kiloNoticeAllowed('alpha', nonce)).rejects.toThrow('Invalid Kilo turn');
});

test('an unknown current-session status withdraws older idle evidence', async () => {
	await startupCompleted();
	await reserveKiloNotice('alpha', nonce);
	await event('busy');
	await event('idle');
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(true);
	await event('future-unknown-status');
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(false);
	await event('idle');
	expect(await kiloNoticeAllowed('alpha', nonce)).toBe(false);
});
