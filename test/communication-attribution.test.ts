import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
	applyTelegramSignal,
	communicationState,
	communicationStatus,
	setCommunicationPause,
} from '../src/communication-state.ts';
import { sendHuman } from '../src/local-room-access.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const original = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (original === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = original;
	await fixture.dispose();
});

test('Team Room operator signals record channel and receipt time without attributing ordinary text', async () => {
	expect(await communicationStatus()).toEqual({ paused: false, changedAt: 0, attribution: null });
	const before = Date.now();
	await sendHuman(' HALT ');
	const halted = await communicationStatus();
	expect(halted).toMatchObject({
		paused: true,
		attribution: { channel: 'team-room', actor: { kind: 'operator', id: 'operator' } },
	});
	expect(halted.changedAt).toBeGreaterThanOrEqual(before);
	expect(halted.changedAt).toBeLessThanOrEqual(Date.now());
	await sendHuman('quoted halt is ordinary text');
	expect(await communicationStatus()).toEqual(halted);
	await sendHuman('proceed');
	expect(await communicationStatus()).toMatchObject({
		paused: false,
		attribution: halted.attribution,
	});
});

test('unattributed persisted pauses stay paused and unknown until a new operator decision', async () => {
	const directory = join(fixture.records, 'communications');
	await mkdir(directory);
	await writeFile(
		join(directory, 'state.json'),
		JSON.stringify({ paused: true, changedAt: 123, source: 'local', updates: {} }),
	);
	expect(await communicationStatus()).toEqual({
		paused: true,
		changedAt: 123,
		attribution: null,
	});
	await setCommunicationPause(false);
	expect(await communicationStatus()).toMatchObject({
		paused: false,
		attribution: { channel: 'cli', actor: { kind: 'operator', id: 'operator' } },
	});
});

test('an agent cannot use the operator Room sender to halt or resume communications', async () => {
	const previous = process.env.SUMMON_AGENT;
	await setCommunicationPause(true);
	const halted = await communicationState();
	process.env.SUMMON_AGENT = 'alpha';
	try {
		for (const text of ['halt', 'proceed'])
			expect(await sendHuman(text).catch((error: unknown) => String(error))).toContain(
				'human operator only',
			);
		expect(await communicationState()).toEqual(halted);
	} finally {
		if (previous === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = previous;
	}
});

test('Telegram provenance names the validated human, excludes bot cursors, and survives replay', async () => {
	await applyTelegramSignal('123', 10, 1, 'halt', '456');
	const halted = await communicationStatus();
	expect(halted).toMatchObject({
		paused: true,
		attribution: { channel: 'telegram', actor: { kind: 'telegram-user', id: '456' } },
	});
	expect(halted).not.toHaveProperty('source');
	expect(halted).not.toHaveProperty('updates');
	await applyTelegramSignal('123', 10, 2, 'proceed', '789');
	expect(await communicationStatus()).toEqual(halted);
	await applyTelegramSignal('123', 11, 2, 'proceed', '789');
	expect(await communicationStatus()).toMatchObject({
		paused: false,
		attribution: { channel: 'telegram', actor: { kind: 'telegram-user', id: '789' } },
	});
});

test('stale Telegram proceed advances its cursor without replacing a newer local pause attribution', async () => {
	await setCommunicationPause(true, 'team-room');
	const halted = await communicationStatus();
	for (const [id, date] of [
		[10, 1],
		[11, undefined],
		[12, Math.floor(halted.changedAt / 1000)],
	] as const) {
		await applyTelegramSignal('123', id, date, 'proceed', '456');
		expect(await communicationStatus()).toEqual(halted);
		expect((await communicationState()).updates['123']).toBe(id);
	}
	await applyTelegramSignal('123', 13, Math.floor(halted.changedAt / 1000) + 1, 'proceed', '456');
	expect(await communicationStatus()).toMatchObject({
		paused: false,
		attribution: { channel: 'telegram', actor: { kind: 'telegram-user', id: '456' } },
	});
});

test('an invalid Telegram identity cannot change the pause, attribution or update cursor', async () => {
	await setCommunicationPause(true);
	const halted = await communicationState();
	const refused = await applyTelegramSignal('123', 10, 1, 'proceed', '').catch((error: unknown) =>
		String(error),
	);
	expect(refused).toContain('Invalid Telegram operator identity');
	expect(await communicationState()).toEqual(halted);
});

test('attribution refuses invalid channels and actors; the display snapshot copies only public fields', async () => {
	await setCommunicationPause(true);
	const path = join(fixture.records, 'communications', 'state.json');
	const state = await communicationState();
	for (const attribution of [
		null,
		{ channel: 'agent', actor: { kind: 'operator', id: 'operator' } },
		{ channel: 'cli', actor: { kind: 'agent', id: 'alpha' } },
		{ channel: 'telegram', actor: { kind: 'telegram-user', id: 'PRIVATE_CANARY' } },
	]) {
		await writeFile(path, JSON.stringify({ ...state, attribution }));
		expect(await communicationStatus().catch((error: unknown) => String(error))).toContain(
			'Invalid communication state',
		);
	}
	await writeFile(
		path,
		JSON.stringify({
			...state,
			attribution: {
				channel: 'cli',
				actor: { kind: 'operator', id: 'operator', extra: 'PRIVATE_CANARY' },
			},
		}),
	);
	expect(JSON.stringify(await communicationStatus())).not.toContain('PRIVATE_CANARY');
});
