import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RoomEvent } from '../src/telegram-room.ts';

import { applyCatchUp } from '../src/checkpoint-skip-apply.ts';
import { prepareCatchUp } from '../src/checkpoint-skip-capture.ts';
import { validateSkipPlan } from '../src/checkpoint-skip-model.ts';
import { skipProgress } from '../src/checkpoint-skip-progress.ts';
import { loadSkipPlan } from '../src/checkpoint-skip-store.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

// Bottleneck item 5 (#28326): an incomplete Telegram refresh no longer refuses catch-up. The plan holds
// the Telegram cursor, skips nothing from Telegram and claims no remote coverage; the room still skips.

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = {
	home: process.env.SUMMON_HOME,
	agent: process.env.SUMMON_AGENT,
	nonce: process.env.SUMMON_NONCE,
};
let network: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	process.env.SUMMON_AGENT = 'alpha';
	process.env.SUMMON_NONCE = 'test-launch';
	network = spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(() => Promise.resolve(Response.json({ ok: true, result: [] })), {
			preconnect: () => undefined,
		}),
	);
});
afterEach(async () => {
	network.mockRestore();
	if (previous.home === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous.home;
	if (previous.agent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previous.agent;
	if (previous.nonce === undefined) delete process.env.SUMMON_NONCE;
	else process.env.SUMMON_NONCE = previous.nonce;
	await fixture.dispose();
});

const telegramCursor = 'runtime/alpha/telegram-123--456.cursor';

async function telegram() {
	const root = join(fixture.records, 'integrations');
	const events: RoomEvent[] = [];
	for (let sequence = 1; sequence <= 45; sequence++)
		events.push({
			sequence,
			messageId: sequence + 100,
			sender: { kind: 'user', id: '1' },
			text: `@beta routine ${sequence} ${'x'.repeat(1100)}`,
			replyTo: null,
		});
	await mkdir(join(root, 'telegram-state/123/-456'), { recursive: true });
	await chmod(root, 0o700);
	await writeFile(
		join(root, 'telegram.json'),
		JSON.stringify({ botToken: '123:fixture', chatId: '-456', allowedUserIds: ['1'] }),
		{ mode: 0o600 },
	);
	await writeFile(join(root, 'telegram-state/123/-456/events.json'), JSON.stringify({ events }));
	return root;
}

/** Enough local room history that the room range skips beyond a one-page tail. */
async function room() {
	for (let index = 0; index < 40; index++)
		await appendLocalEvent({
			sender: { kind: 'agent', id: 'beta' },
			text: `routine room ${index} ${'y'.repeat(1100)}`,
			replyTo: null,
			source: 'local',
		});
}

/** A live process holds the Telegram poll lock (per bot, not per chat), as another session's refresh does. */
async function busyRefresh(root: string) {
	await writeFile(
		join(root, 'telegram-state/123/poll.lock'),
		JSON.stringify({ pid: process.pid, nonce: randomUUID() }),
	);
}

async function failure(operation: () => Promise<unknown>): Promise<string> {
	try {
		await operation();
	} catch (error: unknown) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error('Expected the operation to refuse.');
}

test('a busy Telegram refresh holds the Telegram cursor and still skips the room', async () => {
	const root = await telegram();
	await room();
	await busyRefresh(root);
	const { catchUp } = await prepareCatchUp('alpha', 1);
	expect(catchUp.skipped.room.count).toBeGreaterThan(0);
	expect(catchUp.skipped.telegram).toMatchObject({ from: 0, through: 0, count: 0 });
	expect(catchUp.telegramCoverage).toEqual({ held: true, reason: 'refresh-busy' });
	expect(catchUp.instruction).toContain('no remote coverage is claimed');
	const plan = await loadSkipPlan('alpha', catchUp.id);
	expect(plan.telegramHeld).toBe('refresh-busy');
	expect(plan.references.some((reference) => reference.source === 'telegram')).toBe(false);
	await applyCatchUp('alpha', plan.id);
	expect((await skipProgress('alpha'))?.phase).toBe('applied');
	expect(await fixture.read('runtime/alpha/room.cursor')).toBe(String(plan.room.through));
	expect(await Bun.file(join(fixture.records, telegramCursor)).exists()).toBe(false);
});

test('a failed Telegram request also holds the Telegram cursor instead of refusing', async () => {
	await telegram();
	await room();
	network.mockImplementation(
		Object.assign(() => Promise.reject(new TypeError('fetch failed')), {
			preconnect: () => undefined,
		}),
	);
	const { catchUp } = await prepareCatchUp('alpha', 1);
	expect(catchUp.telegramCoverage).toEqual({ held: true, reason: 'request-failed' });
	expect(catchUp.skipped.telegram?.count).toBe(0);
	await applyCatchUp('alpha', catchUp.id);
	expect(await Bun.file(join(fixture.records, telegramCursor)).exists()).toBe(false);
});

test('a healthy refresh still skips Telegram and claims nothing held', async () => {
	await telegram();
	await room();
	const { catchUp } = await prepareCatchUp('alpha', 1);
	expect(catchUp.skipped.telegram?.count).toBeGreaterThan(0);
	expect(catchUp.telegramCoverage).toBeUndefined();
	expect(catchUp.instruction).not.toContain('Telegram was not refreshed');
	const plan = await loadSkipPlan('alpha', catchUp.id);
	expect(plan.telegramHeld).toBeUndefined();
	await applyCatchUp('alpha', plan.id);
	expect(await fixture.read(telegramCursor)).toBe(String(plan.telegram?.through));
});

test('a held plan still refuses when recorded Telegram changed at or below its cursor', async () => {
	const root = await telegram();
	await room();
	await mkdir(join(fixture.records, 'runtime/alpha'), { recursive: true });
	await writeFile(join(fixture.records, telegramCursor), '2');
	await busyRefresh(root);
	const { catchUp } = await prepareCatchUp('alpha', 1);
	expect(catchUp.skipped.telegram).toMatchObject({ from: 2, through: 2, count: 0 });
	const path = join(root, 'telegram-state/123/-456/events.json');
	const value = JSON.parse(await readFile(path, 'utf8')) as { events: RoomEvent[] };
	const first = value.events[0];
	if (!first) throw new Error('Missing positive source control');
	first.text += ' CHANGED';
	await writeFile(path, JSON.stringify(value));
	expect(await failure(() => applyCatchUp('alpha', catchUp.id))).toContain(
		'Historical source changed',
	);
	expect(await skipProgress('alpha')).toBeUndefined();
	expect(await fixture.read(telegramCursor)).toBe('2');
});

test('an interrupted held apply resumes without touching the Telegram cursor', async () => {
	const root = await telegram();
	await room();
	await busyRefresh(root);
	const { catchUp } = await prepareCatchUp('alpha', 1);
	const lock = join(fixture.records, 'runtime/alpha/room.cursor.lock');
	await writeFile(lock, JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
	expect(await failure(() => applyCatchUp('alpha', catchUp.id))).toContain(
		'Mailbox operation is locked',
	);
	expect((await skipProgress('alpha'))?.phase).toBe('applying');
	// Morgan 3490e448: a pending held apply blocks a fresh plan; only its exact id resumes it.
	expect(await failure(() => prepareCatchUp('alpha', 1))).toContain(
		`Catch-up ${catchUp.id} is incomplete`,
	);
	await unlink(lock);
	await applyCatchUp('alpha', catchUp.id);
	expect((await skipProgress('alpha'))?.phase).toBe('applied');
	expect(await Bun.file(join(fixture.records, telegramCursor)).exists()).toBe(false);
}, 15_000);

test('a recorded halt stays exactly as it was through a held catch-up', async () => {
	const root = await telegram();
	await room();
	await busyRefresh(root);
	const halt = join(fixture.records, 'communications/state.json');
	await mkdir(join(fixture.records, 'communications'), { recursive: true });
	await writeFile(
		halt,
		JSON.stringify({ paused: true, changedAt: 1, source: 'local', updates: {} }),
	);
	const before = await readFile(halt, 'utf8');
	const { catchUp } = await prepareCatchUp('alpha', 1);
	await applyCatchUp('alpha', catchUp.id);
	expect(await readFile(halt, 'utf8')).toBe(before);
	const urls = network.mock.calls.map(([url]) =>
		typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
	);
	expect(urls.some((url) => url.includes('sendMessage'))).toBe(false);
});

test('invalid Telegram configuration still refuses rather than being held', async () => {
	const root = await telegram();
	await room();
	await writeFile(join(root, 'telegram.json'), '{not json');
	expect((await failure(() => prepareCatchUp('alpha', 1))).length).toBeGreaterThan(0);
	expect(await skipProgress('alpha')).toBeUndefined();
});

test('the plan validator refuses a held Telegram range that skips anything', async () => {
	const root = await telegram();
	await room();
	await busyRefresh(root);
	const { catchUp } = await prepareCatchUp('alpha', 1);
	const plan = await loadSkipPlan('alpha', catchUp.id);
	expect(validateSkipPlan(plan, 'alpha').telegramHeld).toBe('refresh-busy');
	const tampered = structuredClone(plan);
	if (!tampered.telegram) throw new Error('Missing held Telegram range');
	tampered.telegram.through = 5;
	tampered.telegram.count = 5;
	expect(() => validateSkipPlan(tampered, 'alpha')).toThrow('Invalid own-session catch-up plan');
	const noRange = structuredClone(plan);
	delete noRange.telegram;
	delete noRange.telegramHash;
	expect(() => validateSkipPlan(noRange, 'alpha')).toThrow('Invalid own-session catch-up plan');
});
