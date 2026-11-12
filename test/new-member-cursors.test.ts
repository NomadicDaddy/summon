import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RoomEvent } from '../src/telegram-room.ts';

import { initializeActivity } from '../src/agent-activity.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { optionalText } from '../src/mail-files.ts';
import { localCursorPath } from '../src/room-cursor.ts';
import { acquireSessionLock } from '../src/session-lock.ts';
import { loadAgent, newRecord, saveAgent } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = { home: process.env.SUMMON_HOME, agent: process.env.SUMMON_AGENT };
let network: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	// Registering a teammate is an operator action.
	delete process.env.SUMMON_AGENT;
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
	await fixture.dispose();
});

async function human(text: string) {
	return appendLocalEvent({
		sender: { kind: 'user', id: 'operator' },
		text,
		replyTo: null,
		source: 'local',
	});
}

/** A post stamped at the given local time on the given day relative to today. */
async function postAt(days: number, hours: number[], text: string) {
	const then = new Date();
	then.setDate(then.getDate() + days);
	then.setHours(hours[0] ?? 0, hours[1] ?? 0, hours[2] ?? 0, hours[3] ?? 0);
	setSystemTime(then);
	try {
		return await human(text);
	} finally {
		setSystemTime();
	}
}

/** Posts from before today, which a new member does not read. */
async function yesterday(...texts: string[]) {
	for (const text of texts) await postAt(-1, [12], text);
}

async function register(name: string) {
	await saveAgent(name, newRecord(name, fixture.root, 'claude'), true);
}

const telegramCursor = (name: string) =>
	join(fixture.records, 'runtime', name, 'telegram-123--456.cursor');

async function telegram(count: number) {
	const root = join(fixture.records, 'integrations');
	const events: RoomEvent[] = [];
	for (let sequence = 1; sequence <= count; sequence++)
		events.push({
			sequence,
			messageId: sequence + 100,
			sender: { kind: 'user', id: '1' },
			text: `operator ${sequence}`,
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
}

interface Package {
	room?: { events: { id: number }[] };
	package?: { forMe: number };
}

test('a new member reads today and what arrives after it joined, never anything older', async () => {
	await yesterday('one', 'two');
	const today = await human('three');
	await register('gamma');
	await initializeActivity('gamma', 'test-launch');
	expect(await optionalText(localCursorPath('gamma'))).toBe('2');
	const later = await human('@gamma after joining');
	const result = await fixture.run(['--checkpoint'], 'gamma');
	expect(result.code).toBe(0);
	const page = JSON.parse(result.out) as Package;
	expect(page.room?.events.map((event) => event.id)).toEqual([today.id, later.id]);
	// Today's operator post counts for every member, as does the post that names gamma.
	expect(page.package?.forMe).toBe(2);
});

test('the first post at local midnight is read, and a later backdated post does not skip it', async () => {
	const late = await postAt(-1, [23, 59, 59, 999], 'late yesterday');
	await postAt(0, [0], 'midnight');
	// A mirrored post can arrive later stamped before midnight; today's first post still counts.
	await postAt(-1, [23], 'backdated');
	await register('gamma');
	expect(await optionalText(localCursorPath('gamma'))).toBe(String(late.id));
});

test('a post with an unreadable time refuses the registration before any cursor or record', async () => {
	const post = await human('one');
	const path = join(fixture.records, 'room', 'events.json');
	const raw = await readFile(path, 'utf8');
	await writeFile(path, raw.replace(JSON.stringify(post.at), '"not a time"'));
	expect(await refusal('gamma')).toContain(
		`Room post #${String(post.id)} has an unreadable time`,
	);
	expect(await optionalText(localCursorPath('gamma'))).toBeUndefined();
	expect(await loadAgent('gamma')).toBeUndefined();
});

test('a Room posted to only today starts a new member at zero', async () => {
	for (const text of ['one', 'two']) await human(text);
	await register('gamma');
	expect(await optionalText(localCursorPath('gamma'))).toBe('0');
});

test('an empty Room starts a new member at zero and Telegram is untouched without a config', async () => {
	await register('gamma');
	expect(await optionalText(localCursorPath('gamma'))).toBe('0');
	expect(await optionalText(telegramCursor('gamma'))).toBeUndefined();
});

test('a configured Telegram mirror starts a new member at its last cached sequence', async () => {
	await telegram(7);
	await yesterday('local');
	await register('gamma');
	expect(await optionalText(telegramCursor('gamma'))).toBe('7');
	expect(await optionalText(localCursorPath('gamma'))).toBe('1');
});

test('an update to an existing member never moves its cursors', async () => {
	for (const text of ['one', 'two']) await human(text);
	// alpha is already registered by the harness, without a cursor: an update leaves it alone.
	const alpha = await loadAgent('alpha');
	if (!alpha) throw new Error('alpha is registered by the harness.');
	await saveAgent('alpha', alpha);
	expect(await optionalText(localCursorPath('alpha'))).toBeUndefined();
});

test('a reused name starts fresh, not at a cursor left under that name', async () => {
	await mkdir(join(fixture.records, 'runtime', 'delta'), { recursive: true });
	await writeFile(localCursorPath('delta'), '1');
	await telegram(9);
	await writeFile(telegramCursor('delta'), '2');
	await yesterday('one', 'two', 'three', 'four');
	await register('delta');
	expect(await readFile(localCursorPath('delta'), 'utf8')).toBe('4');
	expect(await readFile(telegramCursor('delta'), 'utf8')).toBe('9');
});

test('a refused duplicate registration leaves the first cursor as it was', async () => {
	await yesterday('one');
	await register('gamma');
	let refused = '';
	try {
		await register('gamma');
	} catch (error: unknown) {
		refused = error instanceof Error ? error.message : String(error);
	}
	expect(refused).toBe('That teammate already exists.');
	expect(await optionalText(localCursorPath('gamma'))).toBe('1');
});

async function refusal(name: string): Promise<string> {
	try {
		await register(name);
	} catch (error: unknown) {
		return error instanceof Error ? error.message : String(error);
	}
	return '';
}

test('a cached-empty Telegram mirror starts a new member at zero', async () => {
	await telegram(0);
	await register('gamma');
	expect(await optionalText(telegramCursor('gamma'))).toBe('0');
});

test('retained checkpoint or catch-up state under a reused name is refused, never inherited', async () => {
	const runtime = join(fixture.records, 'runtime', 'delta');
	for (const entry of [
		'checkpoint.json',
		'checkpoint-package.json',
		'checkpoint-catch-up.json',
	]) {
		await mkdir(runtime, { recursive: true });
		await writeFile(join(runtime, entry), '{"frozen":true}');
		expect(await refusal('delta')).toContain('Checkpoint state from an earlier delta remains');
		expect(await readFile(join(runtime, entry), 'utf8')).toBe('{"frozen":true}');
		expect(await loadAgent('delta')).toBeUndefined();
		expect(await optionalText(localCursorPath('delta'))).toBeUndefined();
		await rm(join(runtime, entry));
	}
	await mkdir(join(runtime, 'checkpoint-skips'));
	expect(await refusal('delta')).toContain('Checkpoint state from an earlier delta remains');
});

test('the creator holding the name lock, and the stale lock a removal leaves, both register', async () => {
	await yesterday('one');
	// The CLI and Team Maintenance take the name's session lock before creating it; that lock is
	// what refuses a live session, so it must not refuse its own creation.
	const lock = await acquireSessionLock('delta');
	if (!lock) throw new Error('The test holds the only lock.');
	try {
		await register('delta');
		expect(await optionalText(localCursorPath('delta'))).toBe('1');
	} finally {
		await lock.release();
	}
	const stale = join(fixture.records, 'runtime', 'epsilon', 'session.lock');
	await mkdir(stale, { recursive: true });
	await writeFile(
		join(stale, 'owner.json'),
		JSON.stringify({ pid: 2147483646, nonce: randomUUID() }),
	);
	await register('epsilon');
	expect(await optionalText(localCursorPath('epsilon'))).toBe('1');
});

test('redirected member storage is refused before any cursor is written', async () => {
	const elsewhere = join(fixture.root, 'elsewhere');
	await mkdir(elsewhere);
	await mkdir(join(fixture.records, 'runtime'), { recursive: true });
	await symlink(elsewhere, join(fixture.records, 'runtime', 'gamma'), 'junction');
	expect(await refusal('gamma')).toContain('Refusing to write through redirected member storage');
	expect(await readdir(elsewhere)).toEqual([]);
	expect(await loadAgent('gamma')).toBeUndefined();
});

test('an invalid new record is refused before any cursor is written', async () => {
	const record = newRecord('gamma', fixture.root, 'claude');
	Object.assign(record, { provider: 'nobody' });
	let message = '';
	try {
		await saveAgent('gamma', record, true);
	} catch (error: unknown) {
		message = error instanceof Error ? error.message : String(error);
	}
	expect(message).toBe('Refusing to save an invalid agent record.');
	expect(await optionalText(localCursorPath('gamma'))).toBeUndefined();
});
