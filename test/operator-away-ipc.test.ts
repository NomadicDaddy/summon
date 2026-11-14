import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mailHarness } from './fixtures/mail-harness.ts';

// The Team Window's half of operator Away: toggles, the clears main sees itself (teammate terminal,
// Room send, control answer) and the renderer's reports, stamped in main on arrival.
type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
const listeners = new Map<string, Handler>();
await mock.module('electron', () => ({
	ipcMain: {
		handle: (name: string, handler: Handler) => handlers.set(name, handler),
		on: (name: string, handler: Handler) => listeners.set(name, handler),
	},
}));
const { operatorAwayIpc } = await import('../src/desktop/operator-away.ts');
const { isAwayShortcut, shouldReportPresence } = await import('../src/desktop/away-control.ts');
const { awayRoomText, operatorAwayPath, readOperatorAway, setOperatorAway } =
	await import('../src/operator-away.ts');
const { localEvents } = await import('../src/local-room.ts');

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previousRoot = process.env.SUMMON_HOME;
const errors: unknown[] = [];
let publishes = 0;

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	delete process.env.SUMMON_AGENT;
	handlers.clear();
	listeners.clear();
	errors.length = 0;
	publishes = 0;
});
afterEach(async () => {
	if (previousRoot === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousRoot;
	await fixture.dispose();
});

const trusted = (): void => undefined;
const settled = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5));
};
async function control() {
	const away = operatorAwayIpc(
		trusted,
		() => {
			publishes++;
			return Promise.resolve();
		},
		(error) => errors.push(error),
	);
	await settled();
	return away;
}
const toggle = (cause: string) => handlers.get('team:operator-away-toggle')?.({}, cause);
const report = (...args: unknown[]) => listeners.get('team:operator-input')?.({}, ...args);

test('button and shortcut toggle the same stored state, and an invalid cause is refused', async () => {
	const away = await control();
	const before = publishes;
	expect(((await toggle('button')) as { view: { state: string } }).view.state).toBe('away');
	expect(away.view().state).toBe('away');
	// A confirmed change republishes the snapshot, so the masthead and teammates see it.
	expect(publishes).toBe(before + 1);
	expect(((await toggle('shortcut')) as { view: { state: string } }).view.state).toBe('here');
	let refused = false;
	try {
		await toggle('teammate-terminal');
	} catch {
		refused = true;
	}
	expect(refused).toBe(true);
	expect((await readOperatorAway()).state).toBe('here');
});

test('main clears on a human terminal key, a Room send and an answer, once, while Away', async () => {
	for (const cause of ['teammate-terminal', 'room-send', 'control-answer'] as const) {
		const away = await control();
		await toggle('shortcut');
		away.input(cause);
		away.input(cause);
		await settled();
		expect((await readOperatorAway()).state).toBe('here');
		expect(away.view().state).toBe('here');
	}
	const backLines = (await localEvents()).filter((event) => event.text === awayRoomText(false));
	expect(backLines).toHaveLength(3);
});

test('input while Here writes nothing, and a renderer report is stamped in main', async () => {
	const away = await control();
	away.input('room-send');
	await settled();
	expect((await localEvents()).filter((event) => event.text.startsWith('Away'))).toHaveLength(0);
	await toggle('button');
	// A renderer clock far in the past is ignored: main stamps the report when it arrives.
	report('room-draft', 0);
	await settled();
	expect((await readOperatorAway()).state).toBe('here');
});

test('renderer reports accept only the renderer surfaces', async () => {
	const away = await control();
	await toggle('button');
	for (const cause of ['button', 'shortcut', 'teammate-terminal', 'room-send', 'telegram', 42])
		report(cause);
	await settled();
	expect(away.view().state).toBe('away');
	report('maintenance');
	await settled();
	expect(away.view().state).toBe('here');
});

test('a declined presence report never latches: the next one after the interval is sent', () => {
	const away = { state: 'away', since: new Date().toISOString() } as const;
	expect(shouldReportPresence(away, null, 1000)).toBe(true);
	expect(shouldReportPresence(away, 1000, 1200)).toBe(false);
	expect(shouldReportPresence(away, 1000, 1500)).toBe(true);
	expect(shouldReportPresence({ state: 'here' }, null, 1000)).toBe(false);
	expect(shouldReportPresence(undefined, null, 1000)).toBe(false);
});

test('each team keeps its own Away', async () => {
	await setOperatorAway(true, 'button');
	const other = await mkdtemp(join(tmpdir(), 'summon-away-other-'));
	try {
		process.env.SUMMON_HOME = other;
		expect((await readOperatorAway()).state).toBe('here');
	} finally {
		process.env.SUMMON_HOME = fixture.records;
		await rm(other, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
	expect((await readOperatorAway()).state).toBe('away');
});

test('a state file that cannot be read is never replaced: the change fails with no Room line', async () => {
	// A directory where the file belongs can't be read, so its contents can't be kept aside.
	await mkdir(operatorAwayPath(), { recursive: true });
	let message = '';
	try {
		await setOperatorAway(true, 'button');
	} catch (error) {
		message = String(error);
	}
	expect(message).toContain('Away was not changed.');
	expect((await localEvents()).filter((event) => event.text === awayRoomText(true))).toHaveLength(
		0,
	);
	expect((await readOperatorAway()).state).toBe('unavailable');
});

// Roger #48243, finding 2: input A, then a toggle, then input B. B came after the toggle, so it
// clears the Away the toggle set; nothing is dropped while A's clear is in flight.
test('an input after a queued toggle clears the Away that toggle sets', async () => {
	const away = await control();
	await toggle('button');
	away.input('room-send');
	const toggled = toggle('shortcut');
	away.input('room-draft');
	await toggled;
	await settled();
	expect((await readOperatorAway()).state).toBe('here');
	expect(away.view().state).toBe('here');
});

// Finding 3: the startup read runs in the same queue, so a toggle made before it lands can't be
// overwritten by it, and input during startup isn't skipped.
test('a toggle and an input during startup settle in order over the startup read', async () => {
	await setOperatorAway(true, 'button');
	const away = operatorAwayIpc(
		trusted,
		() => Promise.resolve(),
		(error) => errors.push(error),
	);
	away.input('teammate-terminal');
	const toggled = toggle('button');
	await toggled;
	await settled();
	expect((await readOperatorAway()).state).toBe('away');
	expect(away.view()).toEqual(await readOperatorAway());
	expect(errors).toEqual([]);
});

// Finding 4: a dispatched Ctrl+Shift+A isn't trusted and never toggles.
test('only a trusted Ctrl+Shift+A is the Away shortcut', () => {
	const press = { altKey: false, code: 'KeyA', ctrlKey: true, metaKey: false, shiftKey: true };
	expect(isAwayShortcut({ ...press, isTrusted: true })).toBe(true);
	expect(isAwayShortcut({ ...press, isTrusted: false })).toBe(false);
	expect(isAwayShortcut({ ...press, isTrusted: true, altKey: true })).toBe(false);
	expect(isAwayShortcut({ ...press, isTrusted: true, code: 'KeyS' })).toBe(false);
});
