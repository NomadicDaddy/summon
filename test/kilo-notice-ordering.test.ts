import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
	initializeKiloTurn,
	invalidateKiloTurn,
	kiloNoticeAllowed,
	kiloStartupSettled,
	kiloStartupSubmitting,
	kiloTurn,
	observeKiloTurn,
} from '../src/kilo-turn-state.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

// Phillip #22057 on #22056: a Kilo notice waits for an observed busy then idle after the startup
// input, with its POST outcome settled. Cases follow the r3 design's tests 1-13.

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const oldHome = process.env.SUMMON_HOME;
const nonce = 'ordering-kilo';
const thread = 'ses_exact';
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await initializeKiloTurn('alpha', nonce, thread, 'stream-one');
});
afterEach(async () => {
	if (oldHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = oldHome;
	await fixture.dispose();
});

const native = (status: string, observer = 'stream-one', sessionID = thread) =>
	observeKiloTurn('alpha', nonce, observer, {
		type: 'session.status',
		properties: { sessionID, status: { type: status } },
	});
const submitting = () => kiloStartupSubmitting('alpha', nonce, thread);
const settle = (outcome: 'accepted' | 'uncertain') =>
	kiloStartupSettled('alpha', nonce, thread, outcome);
const allowed = () => kiloNoticeAllowed('alpha', nonce);

test('1. accepted before the first busy: nothing until the observed idle', async () => {
	await submitting();
	await settle('accepted');
	expect(await allowed()).toBe(false);
	await native('busy');
	expect(await allowed()).toBe(false);
	await native('idle');
	expect(await allowed()).toBe(true);
});

test('2. busy before the response, idle after it: allowed at the idle, with no stall', async () => {
	await submitting();
	await native('busy');
	await settle('accepted');
	expect(await allowed()).toBe(false);
	await native('idle');
	expect(await allowed()).toBe(true);
});

test('3. timeout, then a late busy and idle: allowed only after that idle', async () => {
	await submitting();
	await settle('uncertain');
	expect(await allowed()).toBe(false);
	await native('busy');
	expect(await allowed()).toBe(false);
	await native('idle');
	expect(await allowed()).toBe(true);
});

test('4. the stream lost while the turn is busy keeps notices queued', async () => {
	await submitting();
	await settle('accepted');
	await native('busy');
	await invalidateKiloTurn('alpha', nonce, 'stream-one');
	expect(await allowed()).toBe(false);
	expect((await kiloTurn('alpha', nonce))?.phase).toBe('unknown');
});

test('5. an idle before the mark, or with no busy after it, never counts', async () => {
	await native('busy');
	await native('idle');
	expect((await kiloTurn('alpha', nonce))?.phase).toBe('unknown'); // Before the mark: ignored.
	await submitting();
	await native('idle');
	await settle('accepted');
	expect(await allowed()).toBe(false);
});

test('6. a stale observer or another thread cannot complete the startup turn', async () => {
	await submitting();
	await initializeKiloTurn('alpha', nonce, thread, 'stream-two');
	await native('busy', 'stream-one');
	await native('idle', 'stream-one');
	await native('busy', 'stream-two', 'child-session');
	await native('idle', 'stream-two', 'child-session');
	await settle('accepted');
	expect(await allowed()).toBe(false);
	await native('busy', 'stream-two');
	await native('idle', 'stream-two');
	expect(await allowed()).toBe(true);
});

test('7. an ambiguous outcome with no events sends nothing', async () => {
	await submitting();
	await settle('uncertain');
	expect(await allowed()).toBe(false);
	expect((await kiloTurn('alpha', nonce))?.startup).toBe('uncertain');
});

test('8. a missing record allows nothing; a version 1 record is refused, not rewritten', async () => {
	expect(await kiloNoticeAllowed('alpha', 'no-such-launch')).toBe(false);
	const path = join(fixture.records, 'runtime', 'alpha', `${nonce}.kilo-turn`);
	const v1 = JSON.stringify({
		version: 1,
		nonce,
		thread,
		observer: 'stream-one',
		phase: 'idle',
		busyObserved: true,
		bootstrapUsed: false,
		generation: 4,
	});
	await writeFile(path, v1);
	expect(allowed()).rejects.toThrow('version 1, from before notice ordering');
	expect(initializeKiloTurn('alpha', nonce, thread)).rejects.toThrow('version 1');
	await submitting().catch(() => {});
	expect(await readFile(path, 'utf8')).toBe(v1);
});

test('10. busy then idle before an ok response: held while submitting, open at once on ok', async () => {
	await submitting();
	await native('busy');
	await native('idle');
	expect((await kiloTurn('alpha', nonce))?.phase).toBe('idle');
	expect(await allowed()).toBe(false);
	await settle('accepted');
	expect((await kiloTurn('alpha', nonce))?.phase).toBe('idle');
	expect(await allowed()).toBe(true);
});

test('11. busy then idle before a timeout or non-OK: open at once, still uncertain', async () => {
	await submitting();
	await native('busy');
	await native('idle');
	await settle('uncertain');
	expect(await allowed()).toBe(true);
	expect((await kiloTurn('alpha', nonce))?.startup).toBe('uncertain');
});

test.each(['invalidated', 'reattached'])(
	'12. observation %s between completion and response keeps notices queued',
	async (loss) => {
		await submitting();
		await native('busy');
		await native('idle');
		if (loss === 'invalidated') await invalidateKiloTurn('alpha', nonce, 'stream-one');
		else await initializeKiloTurn('alpha', nonce, thread, 'stream-two');
		await settle('accepted');
		expect(await allowed()).toBe(false);
	},
);

test('13. an initial idle and a lone idle after the mark leave the seat queued', async () => {
	await native('idle');
	await submitting();
	await native('idle');
	await settle('accepted');
	expect(await allowed()).toBe(false);
	expect((await kiloTurn('alpha', nonce))?.busyObserved).toBe(false);
});

test('the outcome is written once, only after submitting, and only for this thread', async () => {
	await settle('accepted');
	expect((await kiloTurn('alpha', nonce))?.startup).toBe('none');
	await kiloStartupSubmitting('alpha', nonce, 'other-thread');
	expect((await kiloTurn('alpha', nonce))?.startup).toBe('none');
	await submitting();
	await kiloStartupSettled('alpha', nonce, 'other-thread', 'accepted');
	expect((await kiloTurn('alpha', nonce))?.startup).toBe('submitting');
	await settle('uncertain');
	await settle('accepted');
	expect((await kiloTurn('alpha', nonce))?.startup).toBe('uncertain');
	await submitting();
	expect((await kiloTurn('alpha', nonce))?.startup).toBe('uncertain');
});
