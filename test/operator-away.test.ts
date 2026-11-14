import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { setCommunicationPause } from '../src/communication-state.ts';
import { awayLabel } from '../src/desktop/away-control.ts';
import { localEvents } from '../src/local-room.ts';
import { optionalText } from '../src/mail-files.ts';
import { operatorPresenceLine } from '../src/mailbox.ts';
import {
	awayRoomText,
	operatorAwayPath,
	readOperatorAway,
	setOperatorAway,
} from '../src/operator-away.ts';
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

const AWAY = awayRoomText(true);
const BACK = awayRoomText(false);
/** Away lines in the Room, each checked to come from Summon rather than read as the operator's own. */
const awayLines = async () =>
	(await localEvents())
		.filter((event) => event.text === AWAY || event.text === BACK)
		.map((event) => {
			expect(event.sender).toEqual({ kind: 'cli', id: 'Summon' });
			return event.text;
		});
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
	expect(await awayLines()).toEqual([AWAY, BACK]);
});

test('input clears a confirmed Away once, writes nothing while Here, and never sets Away', async () => {
	await setOperatorAway(true, 'shortcut');
	expect((await setOperatorAway(false, 'room-draft')).changed).toBe(true);
	// Repeated input while Here writes nothing more.
	expect((await setOperatorAway(false, 'notepad')).changed).toBe(false);
	expect(await awayLines()).toHaveLength(2);
	await rejected(setOperatorAway(true, 'notepad'), 'Only the Away control sets Away.');
});

test('a teammate can read Away but never set or clear it', async () => {
	await setOperatorAway(true, 'button');
	process.env.SUMMON_AGENT = 'alpha';
	expect((await readOperatorAway()).state).toBe('away');
	await rejected(setOperatorAway(false, 'button'));
	await rejected(setOperatorAway(false, 'teammate-terminal'));
	delete process.env.SUMMON_AGENT;
	expect((await readOperatorAway()).state).toBe('away');
});

test('malformed state reads unavailable, input leaves it alone, and an explicit change keeps the old bytes', async () => {
	const path = operatorAwayPath();
	await setOperatorAway(false, 'button').catch(() => undefined);
	await writeFile(path, '{"version":1,"state":"away"}');
	const read = await readOperatorAway();
	expect(read.state).toBe('unavailable');
	expect((await setOperatorAway(false, 'search')).changed).toBe(false);
	expect(await optionalText(path)).toBe('{"version":1,"state":"away"}');
	expect((await setOperatorAway(true, 'button')).changed).toBe(true);
	const kept = (await readdir(dirname(path))).filter((name) =>
		name.startsWith('operator-away.json.unreadable-'),
	);
	expect(kept).toHaveLength(1);
	expect((await readOperatorAway()).state).toBe('away');
});

test('an unavailable reason never quotes the file, which teammates would read', async () => {
	await setOperatorAway(true, 'button');
	await writeFile(operatorAwayPath(), 'SECRET_SENTINEL');
	const notJson = await readOperatorAway();
	expect(notJson).toEqual({
		state: 'unavailable',
		error: 'The Away state file is not valid JSON.',
	});
	await writeFile(operatorAwayPath(), '{"version":1,"state":"SECRET_SENTINEL"}');
	const notRecord = await readOperatorAway();
	expect(JSON.stringify(notRecord)).not.toContain('SECRET_SENTINEL');
	expect(operatorPresenceLine(notRecord)).not.toContain('SECRET_SENTINEL');
	expect(awayLabel(notRecord).title).not.toContain('SECRET_SENTINEL');
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
	expect(await awayLines()).toEqual([AWAY]);
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
