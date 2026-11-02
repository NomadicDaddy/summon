import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { Hold } from '../src/mail-attention.ts';

import { checkpointHash } from '../src/checkpoint-package-model.ts';
import { checkpoint } from '../src/checkpoint.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { atomicWrite } from '../src/mail-files.ts';
import { readOwnChunk } from '../src/mail-read.ts';
import { sendMessage } from '../src/mailbox.ts';
import { responseStatus } from '../src/response-watchdog-store.ts';
import { evaluateResponseWatchdog } from '../src/response-watchdog.ts';
import { roomCursorPath } from '../src/telegram-live.ts';
import { recordRoomEvent } from '../src/telegram-room.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let now = 1000000;
let wall: ReturnType<typeof spyOn<typeof Date, 'now'>>;
let mono: ReturnType<typeof spyOn<typeof performance, 'now'>>;
const previous = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
};
const config = { botToken: '123:fixture', chatId: '456', allowedUserIds: ['456'] };
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = 'proof-fixture';
	now = 1000000;
	wall = spyOn(Date, 'now').mockImplementation(() => now);
	mono = spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(async () => {
	wall.mockRestore();
	mono.mockRestore();
	if (previous.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous.home;
	if (previous.agent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previous.agent;
	if (previous.nonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = previous.nonce;
	await fixture.dispose();
});
const evaluate = () => evaluateResponseWatchdog('alpha', 'proof-fixture');
const status = () => responseStatus('alpha', 'proof-fixture');

test('first page acknowledged between evaluations counts once; replay does not', async () => {
	await atomicWrite(join(fixture.records, 'runtime/alpha/proof-fixture.ready'), 'proof-fixture');
	await sendMessage('alpha', 'alpha', 'long body '.repeat(12000));
	await evaluate();
	now += 590000;
	const first = await checkpoint();
	await checkpoint(String(first.receipt));
	await evaluate();
	expect((await status())?.expectations[0]?.progressAt).toBe(now);
	expect((await status())?.expectations[0]?.progress).toBe(1);
	now += 10000;
	await checkpoint();
	await evaluate();
	expect((await status())?.phase).toBe('observing');
	expect((await status())?.expectations[0]?.progress).toBe(1);
});

test('five exact sources clear independently; old hold fingerprint cannot cover a new decision', async () => {
	const mail = await sendMessage('alpha', 'alpha', 'mail');
	await appendLocalEvent({
		sender: { kind: 'user', id: 'operator' },
		text: 'room',
		replyTo: null,
		source: 'local',
	});
	await atomicWrite(join(fixture.records, 'integrations/telegram.json'), JSON.stringify(config));
	await recordRoomEvent(config, {
		messageId: 1,
		text: 'telegram',
		sender: { kind: 'user', id: '456' },
		replyTo: null,
	});
	const hold: Hold = {
		id: randomUUID(),
		agent: 'alpha',
		messageId: randomUUID(),
		sender: 'beta',
		reason: 'fixture',
		proposal: 'fixture',
		digest: 'fixture',
		createdAt: new Date().toISOString(),
		decision: 'approve',
		userReference: 'fixture',
	};
	await atomicWrite(
		join(fixture.records, 'mailboxes/alpha/holds', `${hold.id}.json`),
		JSON.stringify(hold),
	);
	await evaluate();
	expect(
		new Set(Object.values((await status())?.targets ?? {}).map((item) => item.source)).size,
	).toBe(5);
	await atomicWrite(join(fixture.records, 'runtime/alpha/proof-fixture.ready'), 'proof-fixture');
	await evaluate();
	expect((await status())?.expectations).toHaveLength(4);
	await readOwnChunk('alpha', mail, 0, 32768);
	await atomicWrite(join(fixture.records, 'runtime/alpha/room.cursor'), '1');
	await atomicWrite(roomCursorPath(config, 'alpha'), '1');
	await evaluate();
	expect(Object.values((await status())?.targets ?? {}).map((item) => item.source)).toEqual([
		'holds',
	]);
	await atomicWrite(
		join(fixture.records, 'runtime/alpha/checkpoint.json'),
		JSON.stringify({ version: 2, seenHolds: { [hold.id]: checkpointHash(hold) } }),
	);
	await evaluate();
	expect((await status())?.phase).toBe('clear');
	await atomicWrite(
		join(fixture.records, 'mailboxes/alpha/holds', `${hold.id}.json`),
		JSON.stringify({ ...hold, decision: 'decline' }),
	);
	await evaluate();
	expect((await status())?.expectations).toHaveLength(1);
});

test('advancing an acknowledged frozen page postpones only contained work; replay does not', async () => {
	await atomicWrite(join(fixture.records, 'runtime/alpha/proof-fixture.ready'), 'proof-fixture');
	await sendMessage('alpha', 'alpha', 'long body '.repeat(8000));
	const first = await checkpoint();
	await evaluate();
	now += 250000;
	await sendMessage('alpha', 'alpha', 'later unrelated work');
	await evaluate();
	const later = (await status())?.expectations.find((item) => item.startedAt === now);
	now += 250000;
	await checkpoint(String(first.receipt));
	await evaluate();
	const advanced = await status();
	expect(
		advanced?.expectations.some((item) => item.progressAt === now && item.progress === 1),
	).toBe(true);
	expect(advanced?.expectations.find((item) => item.id === later?.id)?.progressAt).toBe(1250000);
	now += 1000;
	await checkpoint();
	await evaluate();
	expect((await status())?.expectations.some((item) => item.progressAt === now)).toBe(false);
});
