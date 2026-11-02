import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';

import { checkpointHash } from '../src/checkpoint-package-model.ts';
import { prepareLocalRoomNotice } from '../src/local-room-live.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { atomicWrite } from '../src/mail-files.ts';
import { scopedMail } from '../src/mailbox-commands.ts';
import { NotificationNotSentError } from '../src/notification-delivery.ts';
import { outcomePath, saveWakeOutcome, wakeDeliveryStatus } from '../src/wake-delivery-store.ts';
import { deliverWakeParts } from '../src/wake-delivery.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
};
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = 'outcome-fixture';
});
afterEach(async () => {
	if (previous.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous.home;
	if (previous.agent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previous.agent;
	if (previous.nonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = previous.nonce;
	await fixture.dispose();
});

async function send(nonce: string, input: (text: string) => Promise<void>) {
	const part = await prepareLocalRoomNotice('alpha', nonce);
	return part
		? deliverWakeParts('alpha', nonce, [part], input, () => Promise.resolve(true))
		: 'none';
}

async function sendHuman(text: string): Promise<void> {
	await appendLocalEvent({
		sender: { kind: 'user', id: 'operator' },
		text,
		replyTo: null,
		source: 'local',
	});
}

test('new successful work preserves an older uncertain delivery and own status exposes both', async () => {
	await sendHuman('PRIVATE_OLD');
	let calls = 0;
	expect(
		await send('outcome-fixture', () => {
			calls++;
			throw new Error('PRIVATE_PROVIDER_ERROR');
		}),
	).toBe('uncertain');
	await send('outcome-fixture', () => {
		calls++;
		return Promise.resolve();
	});
	expect(calls).toBe(1);
	await sendHuman('PRIVATE_NEW');
	expect(
		await send('outcome-fixture', () => {
			calls++;
			return Promise.resolve();
		}),
	).toBe('submitted');
	const status = await wakeDeliveryStatus('alpha', 'outcome-fixture');
	expect(status.latest?.state).toBe('provider-submitted');
	expect(status.total).toBe(1);
	expect(status.unresolved[0]?.state).toBe('uncertain');
	expect(status.unresolved[0]?.sources[0]?.through).toBe(1);
	expect(await scopedMail(['status'])).toHaveProperty('wakeDelivery.total', 1);
	expect(JSON.stringify(status)).not.toContain('PRIVATE_');
	expect(await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists()).toBe(false);
	const read = await fixture.run(['--room', 'ack', '1'], 'alpha');
	expect(read.code).toBe(0);
	expect((await wakeDeliveryStatus('alpha', 'outcome-fixture')).total).toBe(0);
	expect((await wakeDeliveryStatus('alpha', 'outcome-fixture')).latest?.sources[0]?.through).toBe(
		2,
	);
	const oldId = status.unresolved[0]?.id;
	if (!oldId) throw new Error('Missing retained uncertain outcome.');
	const retained: unknown = JSON.parse(await Bun.file(outcomePath('alpha', oldId)).text());
	expect(retained).toHaveProperty('state', 'acknowledged');
});

test('definitely unsent input retries with backoff and keeps source reading unconfirmed', async () => {
	await sendHuman('retry control');
	let now = Date.now();
	const clock = spyOn(Date, 'now').mockImplementation(() => now);
	let calls = 0;
	try {
		expect(
			send('outcome-fixture', () => {
				calls++;
				throw new NotificationNotSentError('draft');
			}),
		).rejects.toBeInstanceOf(NotificationNotSentError);
		expect((await wakeDeliveryStatus('alpha', 'outcome-fixture')).unresolved[0]?.state).toBe(
			'not-sent',
		);
		await send('outcome-fixture', () => {
			calls++;
			return Promise.resolve();
		});
		expect(calls).toBe(1);
		now += 2001;
		expect(
			await send('outcome-fixture', () => {
				calls++;
				return Promise.resolve();
			}),
		).toBe('submitted');
		expect(calls).toBe(2);
		expect((await wakeDeliveryStatus('alpha', 'outcome-fixture')).total).toBe(0);
		expect(
			(await wakeDeliveryStatus('alpha', 'outcome-fixture')).latest?.failedAt,
		).toBeDefined();
		expect(
			(await wakeDeliveryStatus('alpha', 'outcome-fixture')).latest?.recoveredAt,
		).toBeDefined();
		expect(await Bun.file(join(fixture.records, 'runtime/alpha/room.cursor')).exists()).toBe(
			false,
		);
	} finally {
		clock.mockRestore();
	}
});

test('an interrupted attempted outcome survives receiver replacement without repeating input', async () => {
	await sendHuman('crash control');
	const part = await prepareLocalRoomNotice('alpha', 'outcome-fixture');
	if (!part) throw new Error('Missing positive control.');
	const targets = [part.target];
	const id = checkpointHash(['alpha', 'outcome-fixture', targets]);
	const now = new Date().toISOString();
	await saveWakeOutcome({
		version: 1,
		owner: 'alpha',
		nonce: 'outcome-fixture',
		id,
		targets,
		state: 'attempted',
		stage: 'notification delivery',
		attempts: 1,
		retryAt: 0,
		createdAt: now,
		updatedAt: now,
	});
	let calls = 0;
	await send('outcome-fixture', () => {
		calls++;
		return Promise.resolve();
	});
	expect(calls).toBe(0);
	expect((await wakeDeliveryStatus('alpha', 'outcome-fixture')).unresolved[0]?.state).toBe(
		'attempted',
	);
	await sendHuman('later positive control');
	await send('outcome-fixture', () => {
		calls++;
		return Promise.resolve();
	});
	expect(calls).toBe(1);
	expect((await wakeDeliveryStatus('alpha', 'replacement-fixture')).total).toBe(1);
});

test('foreign or corrupt outcome storage prevents input and never leaks its contents', async () => {
	await sendHuman('valid positive control');
	const part = await prepareLocalRoomNotice('alpha', 'outcome-fixture');
	if (!part) throw new Error('Missing positive control.');
	const id = checkpointHash(['alpha', 'outcome-fixture', [part.target]]);
	await atomicWrite(outcomePath('alpha', id), '{"owner":"beta","private":"PRIVATE_CORRUPT"}');
	let calls = 0;
	const result: unknown = await send('outcome-fixture', () => {
		calls++;
		return Promise.resolve();
	}).catch((error: unknown) => error);
	expect(result).toBeInstanceOf(Error);
	expect(String(result)).not.toContain('PRIVATE_CORRUPT');
	expect(calls).toBe(0);
	process.env.SUMMON_AGENT = 'beta';
	expect(wakeDeliveryStatus('alpha', 'outcome-fixture')).rejects.toThrow();
});
