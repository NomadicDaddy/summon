import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TeamEvent } from '../src/desktop/types.ts';
import type { LocalEvent } from '../src/local-room.ts';

import { readPendingMentionWake } from '../src/desktop/mention-wakes.ts';
import { Team, type TerminalProcess } from '../src/desktop/team.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { attachFixtureReceiver, waitForNotice } from './fixtures/wake-team.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});
function harness() {
	const events: TeamEvent[] = [];
	const inputs: string[] = [];
	let launches = 0;
	const sizes: { cols: number | undefined; rows: number | undefined }[] = [];
	let exit: (event: { exitCode: number }) => void = () => {};
	const pty: TerminalProcess = {
		pid: 1,
		onData: () => ({ dispose: () => {} }),
		onExit: (listener) => {
			exit = listener;
			return { dispose: () => {} };
		},
		write: (text) => inputs.push(String(text)),
		resize: () => {},
		kill: () => {},
	};
	const team = new Team(
		'bun',
		'cli.ts',
		(event) => events.push(event),
		(_file, _args, options) => {
			launches++;
			sizes.push({ cols: options.cols, rows: options.rows });
			return pty;
		},
	);
	return {
		team,
		inputs,
		events,
		sizes,
		launches: () => launches,
		exit: () => exit({ exitCode: 0 }),
	};
}
test('a direct user mention wakes an idle team-owned Kilo terminal once', async () => {
	const h = harness();
	await writeFile(
		join(fixture.records, 'jack.json'),
		JSON.stringify(newRecord('jack', fixture.root, 'kilo')),
	);
	await h.team.start('jack');
	await mkdir(join(fixture.records, 'runtime/jack'), { recursive: true });
	await writeFile(
		join(fixture.records, 'runtime/jack/activity.json'),
		JSON.stringify({
			workingOn: 'Available',
			state: 'idle',
			updatedAt: new Date().toISOString(),
			nonce: 'jack-launch',
		}),
	);
	const event = await appendLocalEvent({
		sender: { kind: 'user', id: 'operator' },
		text: '@jack review this',
		replyTo: null,
		source: 'local',
	});

	await h.team.wakeMentions(event);
	await h.team.flushPendingMentionWakes();

	const stop = await attachFixtureReceiver(h.team, 'jack');
	try {
		await waitForNotice(h.inputs, `through ${event.id}`);
		expect(h.inputs).toHaveLength(1);
		expect(await readPendingMentionWake('jack')).toEqual({ through: event.id });
	} finally {
		await stop();
	}
	h.exit();
	await h.team.shutdown();
});

test('busy Kilo sessions retain a mention wake until idle and clear it after reading', async () => {
	const h = harness();
	await writeFile(
		join(fixture.records, 'jack.json'),
		JSON.stringify(newRecord('jack', fixture.root, 'kilo')),
	);
	await h.team.start('jack');
	const activityPath = join(fixture.records, 'runtime/jack/activity.json');
	await mkdir(join(fixture.records, 'runtime/jack'), { recursive: true });
	const activity = (state: 'busy' | 'idle') =>
		JSON.stringify({
			workingOn: state === 'busy' ? 'Running a task' : 'Available',
			state,
			updatedAt: new Date().toISOString(),
			nonce: 'jack-launch',
		});
	await writeFile(activityPath, activity('busy'));
	const event = await appendLocalEvent({
		sender: { kind: 'user', id: 'operator' },
		text: '@jack read this when ready',
		replyTo: null,
		source: 'local',
	});

	await h.team.wakeMentions(event);
	expect(h.inputs).toEqual([]);
	expect(await readPendingMentionWake('jack')).toEqual({ through: event.id });

	await writeFile(activityPath, activity('idle'));
	await h.team.flushPendingMentionWakes();
	const stop = await attachFixtureReceiver(h.team, 'jack');
	try {
		await waitForNotice(h.inputs, `through ${event.id}`);
		expect(h.inputs).toHaveLength(1);
		await h.team.flushPendingMentionWakes();
		expect(h.inputs).toHaveLength(1);
	} finally {
		await stop();
	}

	await writeFile(join(fixture.records, 'runtime/jack/room.cursor'), String(event.id));
	await h.team.flushPendingMentionWakes();
	expect(await readPendingMentionWake('jack')).toEqual({ through: 0 });
	h.exit();
	await h.team.shutdown();
});

test('addressed peer work uses the shared Kilo receiver without a second mention injection', async () => {
	const h = harness();
	await writeFile(
		join(fixture.records, 'jack.json'),
		JSON.stringify(newRecord('jack', fixture.root, 'kilo')),
	);
	await h.team.start('jack');
	await mkdir(join(fixture.records, 'runtime/jack'), { recursive: true });
	await writeFile(
		join(fixture.records, 'runtime/jack/activity.json'),
		JSON.stringify({
			workingOn: 'Available',
			state: 'idle',
			updatedAt: new Date().toISOString(),
			nonce: 'jack-launch',
		}),
	);

	const event = await appendLocalEvent({
		sender: { kind: 'agent', id: 'alpha' },
		text: '@jack please check this',
		replyTo: null,
		source: 'local',
	});
	await h.team.wakeMentions(event);

	expect(h.inputs).toEqual([]);
	expect(await readPendingMentionWake('jack')).toBeUndefined();
	const stop = await attachFixtureReceiver(h.team, 'jack');
	try {
		await waitForNotice(h.inputs, `through ${event.id}`);
		expect(h.inputs).toHaveLength(1);
	} finally {
		await stop();
	}
	h.exit();
	await h.team.shutdown();
});

test('operator CLI mentions use the same idle-only Kilo wake path', async () => {
	const h = harness();
	await writeFile(
		join(fixture.records, 'jack.json'),
		JSON.stringify(newRecord('jack', fixture.root, 'kilo')),
	);
	await h.team.start('jack');
	await mkdir(join(fixture.records, 'runtime/jack'), { recursive: true });
	await writeFile(
		join(fixture.records, 'runtime/jack/activity.json'),
		JSON.stringify({
			workingOn: 'Available',
			state: 'idle',
			updatedAt: new Date().toISOString(),
			nonce: 'jack-launch',
		}),
	);
	const event = await appendLocalEvent({
		sender: { kind: 'cli', id: 'CLI' },
		text: '@jack check this',
		replyTo: null,
		source: 'local',
	});
	await h.team.wakeMentions(event);

	const stop = await attachFixtureReceiver(h.team, 'jack');
	try {
		await waitForNotice(h.inputs, `through ${event.id}`);
		expect(h.inputs).toHaveLength(1);
	} finally {
		await stop();
	}
	h.exit();
	await h.team.shutdown();
});

test('startup recovery launches only unread direct operator mentions since the prior team window', async () => {
	const h = harness();
	await writeFile(
		join(fixture.records, 'jack.json'),
		JSON.stringify(newRecord('jack', fixture.root, 'grok')),
	);
	await mkdir(join(fixture.records, 'runtime/jack'), { recursive: true });
	await writeFile(join(fixture.records, 'runtime/jack/room.cursor'), '4');
	const since = new Date(Date.now() - 10_000).toISOString();
	const event = (
		id: number,
		at: string,
		sender: LocalEvent['sender'],
		text: string,
	): LocalEvent => ({
		id,
		at,
		sender,
		text,
		replyTo: null,
		source: 'local',
	});

	await h.team.recoverMissedMentionWakes(
		[
			event(
				3,
				new Date(Date.now() - 20_000).toISOString(),
				{ kind: 'user', id: 'operator' },
				'@jack old',
			),
			event(
				4,
				new Date().toISOString(),
				{ kind: 'user', id: 'operator' },
				'@jack already read',
			),
			event(
				5,
				new Date().toISOString(),
				{ kind: 'user', id: 'operator' },
				'@jack assigned work',
			),
			event(
				6,
				new Date().toISOString(),
				{ kind: 'agent', id: 'alpha' },
				'@jack peer request',
			),
		],
		since,
	);

	expect(h.launches()).toBe(1);
	h.exit();
	await h.team.shutdown();
});
