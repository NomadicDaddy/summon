import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { sendHuman } from '../src/local-room-access.ts';
import { deliveryStatus, markReady } from '../src/mail-session.ts';
import { startMailWatcher } from '../src/mail-watcher.ts';
import { pendingMessages, sendMessage } from '../src/mailbox.ts';
import { wakeDeliveryStatus } from '../src/wake-delivery-store.ts';
import { wakeErrors } from '../src/wake-errors.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previousHome = process.env.SUMMON_HOME;
const previousAgent = process.env.SUMMON_AGENT;
const previousNonce = process.env.SUMMON_NONCE;
let stop: (() => Promise<void>) | undefined;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	await stop?.();
	stop = undefined;
	if (previousHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousHome;
	if (previousAgent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previousAgent;
	if (previousNonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = previousNonce;
	await fixture.dispose();
});

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (await check()) return;
		await Bun.sleep(10);
	}
	throw new Error('Expected receiver control was not observed.');
}

async function seed(nonce: string): Promise<void> {
	await sendMessage('alpha', 'beta', 'PRIVATE_MAIL_CONTROL');
	await sendHuman('@beta PRIVATE_ROOM_CONTROL');
	process.env.SUMMON_AGENT = 'beta';
	process.env.SUMMON_NONCE = nonce;
}

test('one initial notice combines unread mail and local room watermarks', async () => {
	const nonce = 'combined-fixture';
	await seed(nonce);
	const notices: string[] = [];
	stop = await startMailWatcher('beta', nonce, (text) => {
		notices.push(text);
		return Promise.resolve();
	});
	await eventually(async () => {
		const room = Bun.file(join(fixture.records, 'runtime/beta', `${nonce}-room.notice`));
		return (
			(await Bun.file(join(fixture.records, 'runtime/beta', `${nonce}.attempts`)).exists()) &&
			(await room.exists()) &&
			(await room.text()).includes('"state":"queued"')
		);
	});
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain(`summon --mail ready ${nonce}`);
	expect(notices[0]).toContain('summon room through 1');
	expect(notices[0]).not.toContain('PRIVATE_');
	expect(await Bun.file(join(fixture.records, 'runtime/beta/room.cursor')).exists()).toBe(false);
});

test('new work repeats unconfirmed readiness without a readiness-only loop', async () => {
	const nonce = 'readiness-reminder';
	await seed(nonce);
	const notices: string[] = [];
	stop = await startMailWatcher('beta', nonce, (text) => {
		notices.push(text);
		return Promise.resolve();
	});
	await eventually(() => notices.length === 1);
	await Bun.sleep(2200);
	expect(notices).toHaveLength(1);
	await sendMessage('beta', 'beta', 'new private reminder control');
	await eventually(() => notices.length === 2);
	expect(notices[1]).toContain(`summon --mail ready ${nonce}`);
	expect(notices[1]).toContain('1 new mailbox event');
	expect(notices[1]).not.toContain('private reminder control');
	await Bun.sleep(2200);
	expect(notices).toHaveLength(2);
}, 15000);

test('mail and room producers cannot overlap writes into one receiver', async () => {
	await seed('serialized-fixture');
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let active = 0;
	let peak = 0;
	try {
		stop = await startMailWatcher('beta', 'serialized-fixture', async () => {
			active++;
			peak = Math.max(peak, active);
			await gate;
			active--;
		});
		await eventually(() => active > 0);
		for (let attempt = 0; attempt < 40 && peak === 1; attempt++) await Bun.sleep(10);
		expect(peak).toBe(1);
	} finally {
		release();
	}
});

test('malformed mail leaves a healthy room notice available and recovers only after a real scan', async () => {
	const nonce = 'inventory-recovery';
	await seed(nonce);
	const file = (await pendingMessages('beta'))[0];
	if (!file) throw new Error('Missing mailbox positive control.');
	const path = join(fixture.records, 'mailboxes/beta/inbox', file);
	const original = await Bun.file(path).text();
	await Bun.write(path, 'PRIVATE_CORRUPT');
	const notices: string[] = [];
	stop = await startMailWatcher('beta', nonce, (text) => {
		notices.push(text);
		return Promise.resolve();
	});
	await eventually(async () => (await deliveryStatus('beta', nonce)).state === 'queued-only');
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain('summon room through');
	expect(notices[0]).not.toContain('PRIVATE_');
	const episode = (await wakeErrors('beta')).find((value) => value.stage === 'mail inventory');
	expect(episode?.certainty).toBe('not-sent');
	expect(episode?.recoveredAt).toBeUndefined();
	const viewing = join(fixture.records, 'runtime/team-window/operator-view.json');
	await Bun.write(
		viewing,
		JSON.stringify({ name: 'beta', pid: process.pid, expires: Date.now() + 6000 }),
	);
	await Bun.write(path, original);
	await Bun.sleep(2200);
	expect(
		(await wakeErrors('beta')).find((value) => value.id === episode?.id)?.recoveredAt,
	).toBeUndefined();
	await Bun.write(viewing, '{}');
	await eventually(
		async () =>
			!!(await wakeErrors('beta')).find((value) => value.id === episode?.id)?.recoveredAt,
	);
	await eventually(() => notices.some((text) => text.includes('mailbox event')));
	expect(notices).toHaveLength(2);
}, 15000);

test('an uncertain readiness write can be confirmed by its live model without repeating input', async () => {
	const nonce = 'readiness-recovery';
	process.env.SUMMON_AGENT = 'beta';
	process.env.SUMMON_NONCE = nonce;
	let calls = 0;
	stop = await startMailWatcher('beta', nonce, () => {
		calls++;
		throw new Error('uncertain after input');
	});
	await eventually(
		async () => (await wakeDeliveryStatus('beta', nonce)).unresolved[0]?.state === 'uncertain',
	);
	await eventually(async () => (await deliveryStatus('beta', nonce)).state === 'queued-only');
	expect((await deliveryStatus('beta', nonce)).state).toBe('queued-only');
	await markReady('beta', nonce);
	await eventually(async () => (await deliveryStatus('beta', nonce)).state === 'live');
	expect(calls).toBe(1);
	expect((await wakeDeliveryStatus('beta', nonce)).total).toBe(0);
});

// Multiple receiver cycles and the 2.2 s control need the same harness budget as adjacent cases.
test('empty scans and newer successful notices cannot make old uncertain work healthy', async () => {
	const nonce = 'uncertainty-retained';
	await seed(nonce);
	let calls = 0;
	stop = await startMailWatcher('beta', nonce, () => {
		calls++;
		if (calls === 1) throw new Error('uncertain provider input');
		return Promise.resolve();
	});
	await eventually(async () => (await wakeDeliveryStatus('beta', nonce)).total === 1);
	await markReady('beta', nonce);
	await Bun.sleep(2200);
	expect((await deliveryStatus('beta', nonce)).state).toBe('queued-only');
	expect(calls).toBe(1);
	await sendMessage('beta', 'beta', 'new positive control');
	await eventually(
		async () =>
			(await wakeDeliveryStatus('beta', nonce)).latest?.state === 'provider-submitted',
	);
	expect(calls).toBe(2);
	expect((await wakeDeliveryStatus('beta', nonce)).total).toBe(1);
	expect((await deliveryStatus('beta', nonce)).state).toBe('queued-only');
}, 15000);

test('a retained receiver-cycle error changes live status until a healthy unpaused scan', async () => {
	const nonce = 'cycle-status-recovery';
	const runtime = join(fixture.records, 'runtime/beta');
	await Bun.write(join(runtime, `${nonce}.ready`), nonce);
	let calls = 0;
	stop = await startMailWatcher('beta', nonce, () => {
		calls++;
		return Promise.resolve();
	});
	await eventually(async () => (await deliveryStatus('beta', nonce)).state === 'live');
	const index = join(runtime, 'wake-delivery-unresolved.json');
	await Bun.write(index, 'PRIVATE_CORRUPT_CONTROL');
	await eventually(async () =>
		(await wakeErrors('beta')).some((value) => value.stage === 'receiver cycle'),
	);
	await eventually(async () => (await deliveryStatus('beta', nonce)).state === 'queued-only');
	const episode = (await wakeErrors('beta')).find((value) => value.stage === 'receiver cycle');
	expect(episode?.recoveredAt).toBeUndefined();
	expect(JSON.stringify(episode)).not.toContain('PRIVATE_CORRUPT_CONTROL');
	const viewing = join(fixture.records, 'runtime/team-window/operator-view.json');
	await Bun.write(
		viewing,
		JSON.stringify({ name: 'beta', pid: process.pid, expires: Date.now() + 6000 }),
	);
	await Bun.write(index, JSON.stringify({ version: 1, owner: 'beta', entries: [] }));
	await Bun.sleep(2200);
	expect((await deliveryStatus('beta', nonce)).state).toBe('queued-only');
	expect(
		(await wakeErrors('beta')).find((value) => value.id === episode?.id)?.recoveredAt,
	).toBeUndefined();
	await Bun.write(viewing, '{}');
	await eventually(async () => (await deliveryStatus('beta', nonce)).state === 'live');
	expect(
		(await wakeErrors('beta')).find((value) => value.id === episode?.id)?.recoveredAt,
	).toBeDefined();
	expect(calls).toBe(0);
}, 15000);
