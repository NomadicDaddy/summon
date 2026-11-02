import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { setHibernation } from '../src/hibernation.ts';
import { prepareLocalRoomNotice } from '../src/local-room-live.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { atomicWrite } from '../src/mail-files.ts';
import { responseInventory } from '../src/response-watchdog-inventory.ts';
import {
	receivesRoutineRoom,
	roomWakePolicy,
	saveRoomWakePolicy,
} from '../src/room-wake-policy.ts';
import { loadAgent, newRecord } from '../src/store.ts';
import { prepareTelegramNotice } from '../src/telegram-live.ts';
import { recordRoomEvent } from '../src/telegram-room.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { notifyLocalRoom } from './fixtures/wake-notice.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const saved = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
	quiet: process.env.SUMMON_ROOM_WAKE_QUIET_MS,
};
const config = { botToken: '123:fixture', chatId: '456', allowedUserIds: ['456'] };
const nonce = 'room-policy-fixture';
const policyPath = () => join(fixture.records, 'settings/room-wake.json');
const post = (text = 'Routine peer traffic') =>
	appendLocalEvent({
		sender: { kind: 'agent', id: 'alpha' },
		text,
		replyTo: null,
		source: 'local',
	});
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = '';
	process.env.SUMMON_NONCE = nonce;
	process.env.SUMMON_ROOM_WAKE_QUIET_MS = '0';
	for (const name of ['coordinator', 'planner', 'steward'])
		await atomicWrite(
			join(fixture.records, `${name}.json`),
			JSON.stringify({
				...newRecord(name, fixture.root, 'codex'),
				memberType: name === 'steward' ? 'teammate' : 'pm',
			}),
		);
});
afterEach(async () => {
	for (const [key, value] of Object.entries({
		SUMMON_HOME: saved.home,
		SUMMON_AGENT: saved.agent,
		SUMMON_NONCE: saved.nonce,
		SUMMON_ROOM_WAKE_QUIET_MS: saved.quiet,
	})) {
		if (value === undefined) Reflect.deleteProperty(process.env, key);
		else process.env[key] = value;
	}
	await fixture.dispose();
});

test('new teams have no implicit registration or PM-role exception', async () => {
	await post();
	expect(await roomWakePolicy()).toEqual({ version: 1, routineRecipients: [] });
	for (const name of ['coordinator', 'planner', 'steward', 'beta']) {
		expect(await receivesRoutineRoom(name)).toBe(false);
		expect(await prepareLocalRoomNotice(name, nonce)).toBeUndefined();
		expect(
			(await responseInventory(name, nonce)).targets.filter((item) => item.source === 'room'),
		).toEqual([]);
	}
	expect(await Bun.file(policyPath()).exists()).toBe(false);
	await post('@beta explicit work');
	expect(await prepareLocalRoomNotice('beta', nonce)).toBeDefined();
});

test('two explicitly selected PM names receive routine local and Telegram notices and inventory', async () => {
	await saveRoomWakePolicy(['coordinator', 'planner']);
	await post();
	await atomicWrite(join(fixture.records, 'integrations/telegram.json'), JSON.stringify(config));
	await recordRoomEvent(config, {
		messageId: 1,
		text: 'Routine Telegram peer traffic',
		sender: { kind: 'agent', id: 'alpha' },
		replyTo: null,
	});
	for (const name of ['coordinator', 'planner']) {
		process.env.SUMMON_AGENT = name;
		expect(await prepareLocalRoomNotice(name, nonce)).toBeDefined();
		expect(await prepareTelegramNotice(name, nonce)).toBeDefined();
		const inventory = await responseInventory(name, nonce);
		expect(inventory.targets.filter((item) => item.source === 'room')).toHaveLength(1);
		expect(inventory.targets.filter((item) => item.source === 'telegram')).toHaveLength(1);
	}
	process.env.SUMMON_AGENT = 'steward';
	expect(await prepareLocalRoomNotice('steward', nonce)).toBeUndefined();
	expect(await prepareTelegramNotice('steward', nonce)).toBeUndefined();
});

test('selection grants notices without promoting a teammate or bypassing hibernation', async () => {
	await saveRoomWakePolicy(['steward']);
	expect((await loadAgent('steward'))?.memberType).toBe('teammate');
	await post();
	const notices: string[] = [];
	const send = (text: string) => {
		notices.push(text);
		return Promise.resolve();
	};
	await notifyLocalRoom('steward', nonce, send);
	expect(notices).toHaveLength(1);
	await setHibernation('steward', true);
	await post('More routine peer traffic');
	await notifyLocalRoom('steward', nonce, send);
	expect(notices).toHaveLength(1);
	await setHibernation('steward', false);
	await notifyLocalRoom('steward', nonce, send);
	expect(notices).toHaveLength(2);
});

test('operator can clear the explicit exception; team stores never inherit it', async () => {
	await saveRoomWakePolicy(['coordinator']);
	const other = join(fixture.root, 'another-team');
	await mkdir(other);
	process.env.SUMMON_HOME = other;
	expect(await receivesRoutineRoom('coordinator')).toBe(false);
	process.env.SUMMON_HOME = fixture.records;
	expect(await receivesRoutineRoom('coordinator')).toBe(true);
	await saveRoomWakePolicy([]);
	expect(await receivesRoutineRoom('coordinator')).toBe(false);
});

test('invalid recipients and teammate writes preserve the previous policy bytes', async () => {
	await saveRoomWakePolicy(['coordinator']);
	const before = await readFile(policyPath(), 'utf8');
	for (const invalid of [
		null,
		'planner',
		['../planner'],
		['Planner'],
		['planner', 'planner'],
		['missing'],
		Array(65).fill('planner'),
	])
		expect(await saveRoomWakePolicy(invalid).catch((error: unknown) => error)).toBeInstanceOf(
			Error,
		);
	process.env.SUMMON_AGENT = 'planner';
	expect(await saveRoomWakePolicy(['planner']).catch((error: unknown) => error)).toMatchObject({
		message: 'This command is for the human operator only.',
	});
	expect(await readFile(policyPath(), 'utf8')).toBe(before);
});

test('invalid stored policy reports an inventory failure but preserves addressed work', async () => {
	await atomicWrite(policyPath(), JSON.stringify({ version: 2, routineRecipients: ['steward'] }));
	await post('@beta explicit work');
	expect(await prepareLocalRoomNotice('beta', nonce)).toBeDefined();
	const inventory = await responseInventory('beta', nonce);
	expect(inventory.failures).toContain('room-policy');
	expect(inventory.targets.filter((item) => item.source === 'room')).toHaveLength(1);
});

test('actual CLI exposes read-only show and operator-only set and clear without launching', async () => {
	const instructions = join(fixture.records, 'AGENTS.md');
	expect(await Bun.file(instructions).exists()).toBe(false);
	const show = await fixture.run(['--room', 'wake-policy', 'show']);
	expect(show.code).toBe(0);
	expect(JSON.parse(show.out)).toEqual({ version: 1, routineRecipients: [] });
	expect(await Bun.file(policyPath()).exists()).toBe(false);
	expect(await Bun.file(instructions).exists()).toBe(false);
	const set = await fixture.run(['--room', 'wake-policy', 'set', 'coordinator', 'planner']);
	expect(set.code).toBe(0);
	expect(JSON.parse(set.out) as unknown).toEqual({
		version: 1,
		routineRecipients: ['coordinator', 'planner'],
	});
	expect(await Bun.file(instructions).exists()).toBe(false);
	const before = await readFile(policyPath(), 'utf8');
	expect((await fixture.run(['--room', 'wake-policy', 'set', 'missing'])).code).not.toBe(0);
	expect(await readFile(policyPath(), 'utf8')).toBe(before);
	const denied = await fixture.run(['--room', 'wake-policy', 'clear'], 'alpha');
	expect(denied.code).not.toBe(0);
	expect(await readFile(policyPath(), 'utf8')).toBe(before);
	expect((await fixture.run(['--room', 'wake-policy', 'clear'])).code).toBe(0);
	expect(await Bun.file(instructions).exists()).toBe(false);
	expect(await receivesRoutineRoom('planner')).toBe(false);
	expect(await readFile(fixture.capture, 'utf8')).toBe('');
}, 15000);
