import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { appendLocalEvent } from '../src/local-room.ts';
import { atomicWrite } from '../src/mail-files.ts';
import { deliveryStatus } from '../src/mail-session.ts';
import { createWakeCoordinator } from '../src/wake-coordinator.ts';
import { wakeErrors } from '../src/wake-errors.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = {
	SUMMON_HOME: process.env.SUMMON_HOME,
	SUMMON_AGENT: process.env.SUMMON_AGENT,
	SUMMON_NONCE: process.env.SUMMON_NONCE,
	SUMMON_ROOM_WAKE_QUIET_MS: process.env.SUMMON_ROOM_WAKE_QUIET_MS,
};
const nonce = 'policy-diagnostic-fixture';
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'beta';
	process.env.SUMMON_NONCE = nonce;
	process.env.SUMMON_ROOM_WAKE_QUIET_MS = '0';
	await atomicWrite(join(fixture.records, 'runtime/beta', `${nonce}.ready`), nonce);
});
afterEach(async () => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) Reflect.deleteProperty(process.env, key);
		else process.env[key] = value;
	}
	await fixture.dispose();
});

test('invalid routine policy reports unknown eligibility, preserves addressed work and recovers after a valid scan', async () => {
	const path = join(fixture.records, 'settings/room-wake.json');
	const malformed = JSON.stringify({
		version: 2,
		routineRecipients: ['beta'],
		private: 'PRIVATE_POLICY',
	});
	await atomicWrite(path, malformed);
	await appendLocalEvent({
		sender: { kind: 'agent', id: 'alpha' },
		text: 'Routine peer traffic',
		replyTo: null,
		source: 'local',
	});
	const notices: string[] = [];
	const cycle = createWakeCoordinator(
		'beta',
		nonce,
		(text) => {
			notices.push(text);
			return Promise.resolve();
		},
		() => true,
		() => Promise.resolve(true),
		{ readinessReminder: false },
	);
	await cycle();
	expect(notices).toEqual([]);
	expect((await deliveryStatus('beta', nonce)).state).toBe('queued-only');
	expect((await deliveryStatus('beta', nonce)).reason).toContain(
		'Room wake policy is invalid or unreadable',
	);
	expect((await deliveryStatus('beta', nonce)).reason).not.toContain(
		'notification remains unsent',
	);
	const episode = (await wakeErrors('beta')).find((value) => value.stage === 'room inventory');
	expect(episode).toBeDefined();
	expect(episode?.recoveredAt).toBeUndefined();
	expect(JSON.stringify(await wakeErrors('beta'))).not.toContain('PRIVATE_POLICY');
	expect(await readFile(path, 'utf8')).toBe(malformed);

	await appendLocalEvent({
		sender: { kind: 'agent', id: 'alpha' },
		text: '@beta explicit positive control',
		replyTo: null,
		source: 'local',
	});
	await cycle();
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain('summon room through 2');
	expect((await deliveryStatus('beta', nonce)).reason).toContain(
		'Room wake policy is invalid or unreadable',
	);
	expect(
		(await wakeErrors('beta')).find((value) => value.id === episode?.id)?.recoveredAt,
	).toBeUndefined();
	expect(await readFile(path, 'utf8')).toBe(malformed);

	const valid = JSON.stringify({ version: 1, routineRecipients: [] });
	await atomicWrite(path, valid);
	await cycle();
	expect(
		(await wakeErrors('beta')).find((value) => value.id === episode?.id)?.recoveredAt,
	).toBeDefined();
	expect((await deliveryStatus('beta', nonce)).reason).not.toContain('Room wake policy');
	expect(await readFile(path, 'utf8')).toBe(valid);
	expect(notices).toHaveLength(1);
});
