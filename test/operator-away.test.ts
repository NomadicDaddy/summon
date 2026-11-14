import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { setCommunicationPause } from '../src/communication-state.ts';
import { awayLabel } from '../src/desktop/away-control.ts';
import { localEvents } from '../src/local-room.ts';
import { optionalText } from '../src/mail-files.ts';
import { operatorPresenceLine } from '../src/mailbox.ts';
import { operatorAwayPath, readOperatorAway, setOperatorAway } from '../src/operator-away.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previousRoot = process.env.SUMMON_HOME;
const previousAgent = process.env.SUMMON_AGENT;

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	delete process.env.SUMMON_AGENT;
});
afterEach(async () => {
	if (previousRoot === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousRoot;
	if (previousAgent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previousAgent;
	await fixture.dispose();
});

const awayLines = async () =>
	(await localEvents())
		.filter((event) => /^Operator is (away from|back at) the keyboard\.$/.test(event.text))
		.map((event) => event.text);
/** The repository's await/catch rejection check (test/board.test.ts): `rejects` isn't a Thenable here. */
const rejected = async (work: Promise<unknown>, text = ''): Promise<void> => {
	let message: string | undefined;
	await work.catch((error: unknown) => {
		message = String(error);
	});
	expect(message).toBeDefined();
	if (text) expect(message).toContain(text);
};

test('missing state reads Here, and reading never writes', async () => {
	expect(await readOperatorAway()).toEqual({ state: 'here' });
	expect(await optionalText(operatorAwayPath())).toBeUndefined();
});

test('Away persists with its start time until an explicit clear, with one Room line each way', async () => {
	const set = await setOperatorAway(true, 'button');
	expect(set.changed).toBe(true);
	expect(set.view.state).toBe('away');
	const since = set.view.state === 'away' ? set.view.since : '';
	// A fresh read, as after a Window restart, still says Away, with the same start.
	expect(await readOperatorAway()).toEqual({ state: 'away', since });
	expect((await setOperatorAway(true, 'shortcut')).changed).toBe(false);
	const cleared = await setOperatorAway(false, 'shortcut');
	expect(cleared).toEqual({ changed: true, view: { state: 'here' } });
	expect(await setOperatorAway(false, 'button')).toEqual({
		changed: false,
		view: { state: 'here' },
	});
	expect(await awayLines()).toEqual([
		'Operator is away from the keyboard.',
		'Operator is back at the keyboard.',
	]);
});

test('input clears only an Away set before it, once, and input never sets Away', async () => {
	const set = await setOperatorAway(true, 'shortcut');
	const since = Date.parse(set.view.state === 'away' ? set.view.since : '');
	// An input already in flight before the Away was confirmed leaves it set.
	expect((await setOperatorAway(false, 'teammate-terminal', since - 1)).changed).toBe(false);
	expect((await readOperatorAway()).state).toBe('away');
	expect((await setOperatorAway(false, 'room-draft', since + 1)).changed).toBe(true);
	// Repeated input while Here writes nothing more.
	expect((await setOperatorAway(false, 'notepad', since + 2)).changed).toBe(false);
	expect(await awayLines()).toHaveLength(2);
	await rejected(setOperatorAway(true, 'notepad'), 'Only the Away control sets Away.');
});

test('a teammate can read Away but never set or clear it', async () => {
	await setOperatorAway(true, 'button');
	process.env.SUMMON_AGENT = 'alpha';
	expect((await readOperatorAway()).state).toBe('away');
	await rejected(setOperatorAway(false, 'button'));
	await rejected(setOperatorAway(false, 'teammate-terminal', Date.now() + 1000));
	delete process.env.SUMMON_AGENT;
	expect((await readOperatorAway()).state).toBe('away');
});

test('malformed state reads unavailable, input leaves it alone, and an explicit change keeps the old bytes', async () => {
	const path = operatorAwayPath();
	await setOperatorAway(false, 'button').catch(() => undefined);
	await writeFile(path, '{"version":1,"state":"away"}');
	const read = await readOperatorAway();
	expect(read.state).toBe('unavailable');
	expect((await setOperatorAway(false, 'search', Date.now())).changed).toBe(false);
	expect(await optionalText(path)).toBe('{"version":1,"state":"away"}');
	expect((await setOperatorAway(true, 'button')).changed).toBe(true);
	const kept = (await readdir(dirname(path))).filter((name) =>
		name.startsWith('operator-away.json.unreadable-'),
	);
	expect(kept).toHaveLength(1);
	expect((await readOperatorAway()).state).toBe('away');
});

test('stored state holds only the state, its times and a cause category', async () => {
	await setOperatorAway(true, 'shortcut');
	const stored = JSON.parse((await optionalText(operatorAwayPath())) ?? '{}') as Record<
		string,
		unknown
	>;
	expect(Object.keys(stored).sort()).toEqual(['cause', 'changedAt', 'since', 'state', 'version']);
	expect(stored.cause).toBe('shortcut');
});

test('concurrent changes serialize: exactly one of two Away sets changes the state', async () => {
	const results = await Promise.all([
		setOperatorAway(true, 'button'),
		setOperatorAway(true, 'shortcut'),
	]);
	expect(results.filter((result) => result.changed)).toHaveLength(1);
	expect(await awayLines()).toEqual(['Operator is away from the keyboard.']);
});

test('startup context and the masthead label say the same state, and reading clears nothing', async () => {
	expect(operatorPresenceLine(await readOperatorAway())).toContain('at the keyboard');
	const set = await setOperatorAway(true, 'button');
	const since = set.view.state === 'away' ? set.view.since : '';
	expect(operatorPresenceLine(await readOperatorAway())).toContain(
		`away from the keyboard since ${since}`,
	);
	expect(awayLabel(await readOperatorAway()).text).toStartWith('Away since ');
	expect(awayLabel({ state: 'here' }).text).toBe('Away');
	expect(awayLabel({ state: 'unavailable', error: 'x' }).title).toContain('x');
	expect(operatorPresenceLine({ state: 'unavailable', error: 'bad json' })).toContain(
		'unknown (bad json)',
	);
	expect((await readOperatorAway()).state).toBe('away');
});

test('a halted Room still stores the change and reports the missing line', async () => {
	await setCommunicationPause(true);
	const result = await setOperatorAway(true, 'button');
	expect(result.changed).toBe(true);
	expect(result.roomError).toBeDefined();
	expect((await readOperatorAway()).state).toBe('away');
	expect(await awayLines()).toEqual([]);
});
