import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { queueMentionWake, readPendingMentionWake } from '../src/desktop/mention-wakes.ts';
import { tickRest } from '../src/desktop/rest.ts';
import { createTeamTimers } from '../src/desktop/team-timers.ts';
import { Team } from '../src/desktop/team.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { readRest } from '../src/rest.ts';
import { newRecord } from '../src/store.ts';
import { initialMentionCursor, saveMentionCursor } from '../src/team-mentions.ts';
import { wakeErrors } from '../src/wake-errors.ts';
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
	const launches: string[] = [];
	const inputs: string[] = [];
	const errors: string[] = [];
	const subjects: (string | undefined)[] = [];
	const exits: (() => void)[] = [];
	const team = new Team(
		'bun',
		'cli.ts',
		(event) => {
			if (event.type === 'error') {
				errors.push(event.message);
				subjects.push(event.slug);
			}
		},
		(_file, args) => {
			const slug = args[2] ?? '';
			if (slug === 'alpha') throw new Error('Fixture launch failed');
			launches.push(slug);
			return {
				pid: 1,
				onData: () => ({ dispose: () => {} }),
				onExit: (listener) => {
					exits.push(() => {
						listener({ exitCode: 0 });
					});
					return { dispose: () => {} };
				},
				write: (text) => {
					inputs.push(String(text));
				},
				resize: () => {},
				kill: () => {},
			};
		},
	);
	const timers = createTeamTimers({
		team,
		send: () => {},
		canSend: () => true,
		halted: () => false,
		initialCursor: 0,
		previousTeamStart: null,
	});
	return {
		team,
		timers,
		launches,
		inputs,
		errors,
		subjects,
		close: async () => {
			await timers.stop();
			for (const exit of exits) exit();
			await team.shutdown();
		},
	};
}

test('failed target is retained while other targets and later room events proceed', async () => {
	const h = harness();
	try {
		await saveMentionCursor(0);
		for (const text of ['@all first event', '@beta next event'])
			await appendLocalEvent({
				sender: { kind: 'user', id: 'operator' },
				text,
				replyTo: null,
				source: 'local',
			});
		await h.timers.scanMentions();
		expect(h.launches).toEqual(['beta']);
		expect(await readPendingMentionWake('alpha')).toEqual({ through: 1 });
		expect(await initialMentionCursor()).toBe(2);
		const status = await fixture.run(['--mail', 'status'], 'alpha');
		expect(status.code).toBe(0);
		expect(status.out).toContain('mention wake');
		expect(status.out).toContain('"roomThrough":1');
		expect(status.out).toContain('"certainty":"uncertain"');
		await h.timers.scanMentions();
		expect(h.errors.filter((text) => text.startsWith('alpha mention wake:'))).toHaveLength(1);
		expect(
			h.subjects[h.errors.findIndex((text) => text.startsWith('alpha mention wake:'))],
		).toBe('alpha');
		h.team.error('Window fault: no teammate');
		expect(h.subjects.at(-1)).toBeUndefined();
	} finally {
		await h.close();
	}
});

test('failed durable retention holds the cursor but still attempts other targets', async () => {
	const h = harness();
	try {
		await saveMentionCursor(0);
		await mkdir(join(fixture.records, 'runtime/alpha/mention-wake.json'), { recursive: true });
		await appendLocalEvent({
			sender: { kind: 'user', id: 'operator' },
			text: '@all first event',
			replyTo: null,
			source: 'local',
		});
		await h.timers.scanMentions();
		expect(h.launches).toEqual(['beta']);
		expect(await initialMentionCursor()).toBe(0);
	} finally {
		await h.close();
	}
});

test('malformed earlier record does not block queued PTY delivery and reports once', async () => {
	const h = harness();
	try {
		await writeFile(
			join(fixture.records, 'beta.json'),
			JSON.stringify(newRecord('beta', fixture.root, 'kilo')),
		);
		await initializeActivity('beta', 'fixture-launch');
		await h.team.start('beta', false);
		await writeFile(join(fixture.records, 'alpha.json'), '{}');
		const event = await appendLocalEvent({
			sender: { kind: 'user', id: 'operator' },
			text: '@beta control',
			replyTo: null,
			source: 'local',
		});
		await queueMentionWake('beta', event.id);
		await h.team.flushPendingMentionWakes();
		await h.team.flushPendingMentionWakes();
		const stop = await attachFixtureReceiver(h.team, 'beta');
		try {
			await waitForNotice(h.inputs, `through ${event.id}`);
			expect(h.inputs).toHaveLength(1);
		} finally {
			await stop();
		}
		expect(h.errors.filter((text) => text.startsWith('alpha pending wake:'))).toHaveLength(1);
		const failed = await wakeErrors('alpha');
		expect(failed[0]?.recoveredAt).toBeUndefined();
		await writeFile(
			join(fixture.records, 'alpha.json'),
			JSON.stringify(newRecord('alpha', fixture.root, 'claude')),
		);
		await h.team.flushPendingMentionWakes();
		expect((await wakeErrors('alpha'))[0]?.recoveredAt).toBeUndefined();
	} finally {
		await h.close();
	}
});

test('rest and startup recovery isolate an invalid earlier teammate', async () => {
	const h = harness();
	try {
		await initializeActivity('beta', 'test-launch');
		expect((await fixture.run(['--rest', 'ready'], 'beta')).code).toBe(0);
		const rest = await readRest('beta');
		await writeFile(
			join(fixture.records, 'runtime/beta/rest.json'),
			JSON.stringify({ ...rest, mode: 'waking' }),
		);
		await writeFile(join(fixture.records, 'alpha.json'), '{}');
		await tickRest(h.team);
		expect((await readRest('beta'))?.mode).toBe('uncertain');
		await writeFile(
			join(fixture.records, 'beta.json'),
			JSON.stringify(newRecord('beta', fixture.root, 'kilo')),
		);
		const event = await appendLocalEvent({
			sender: { kind: 'user', id: 'operator' },
			text: '@all recover',
			replyTo: null,
			source: 'local',
		});
		await h.team.recoverMissedMentionWakes([event], new Date(Date.now() - 60000).toISOString());
		expect(h.launches).toEqual(['beta']);
		expect(await readPendingMentionWake('alpha')).toEqual({ through: event.id });
	} finally {
		await h.close();
	}
});

test('repaired peer wake retention waits for the shared receiver and preserves later human work', async () => {
	const h = harness();
	try {
		const path = join(fixture.records, 'beta.json');
		const record = JSON.stringify(newRecord('beta', fixture.root, 'kilo'));
		await writeFile(path, record);
		await initializeActivity('beta', 'fixture-launch');
		await h.team.start('beta', false);
		await writeFile(path, '{}');
		const event = await appendLocalEvent({
			sender: { kind: 'agent', id: 'alpha' },
			text: '@beta peer request',
			replyTo: null,
			source: 'local',
		});
		await h.team.wakeMentions(event);
		await writeFile(path, record);
		await h.team.flushPendingMentionWakes();
		expect(h.inputs).toEqual([]);
		expect((await readPendingMentionWake('beta'))?.through).toBe(event.id);
		const human = await appendLocalEvent({
			sender: { kind: 'user', id: 'operator' },
			text: '@beta direct request',
			replyTo: null,
			source: 'local',
		});
		await h.team.wakeMentions(human);
		expect(h.inputs).toHaveLength(0);
		const stop = await attachFixtureReceiver(h.team, 'beta');
		try {
			await waitForNotice(h.inputs, `through ${human.id}`);
			expect(h.inputs).toHaveLength(1);
		} finally {
			await stop();
		}
	} finally {
		await h.close();
	}
});
