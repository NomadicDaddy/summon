import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWrite } from '../src/mail-files.ts';
import { createSchedule, listSchedules, restSchedules } from '../src/schedules.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previousHome = process.env.SUMMON_HOME;
const previousAgent = process.env.SUMMON_AGENT;

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	delete process.env.SUMMON_AGENT;
});
afterEach(async () => {
	if (previousHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousHome;
	if (previousAgent === undefined) delete process.env.SUMMON_AGENT;
	else process.env.SUMMON_AGENT = previousAgent;
	await fixture.dispose();
});

test('rest reads reuse an unchanged validated schedule state and retain finished runs', async () => {
	const schedule = await createSchedule({
		owner: 'alpha',
		title: 'Fixture duty',
		prompt: 'Do fixture work',
		everyMinutes: 60,
	});
	const state = await listSchedules();
	const finished = {
		id: randomUUID(),
		scheduleId: schedule.id,
		owner: 'alpha',
		title: schedule.title,
		prompt: schedule.prompt,
		dueAt: 100,
		updatedAt: 200,
		status: 'complete' as const,
		result: 'Retained fixture evidence',
	};
	state.runs.push(finished);
	await writeFile(join(fixture.records, 'schedules', 'state.json'), JSON.stringify(state));
	const first = await restSchedules();
	expect(await restSchedules()).toBe(first);
	expect(first.runs).toEqual([finished]);

	// Public list callers get a separate mutable read; they cannot poison rest's cached value.
	const listed = await listSchedules();
	const listedSchedule = listed.schedules[0];
	if (!listedSchedule) throw new Error('Missing fixture schedule');
	listedSchedule.title = 'Local caller change';
	expect((await restSchedules()).schedules[0]?.title).toBe('Fixture duty');
});

test('rest reads observe schedule writes and a same-size atomic replacement', async () => {
	await createSchedule({
		owner: 'alpha',
		title: 'First duty',
		prompt: 'Do fixture work',
		everyMinutes: 60,
	});
	const before = await restSchedules();
	await createSchedule({
		owner: 'beta',
		title: 'Second duty',
		prompt: 'Do other fixture work',
		everyMinutes: 60,
	});
	const after = await restSchedules();
	expect(after).not.toBe(before);
	expect(after.schedules.map((schedule) => schedule.owner)).toEqual(['alpha', 'beta']);
	const edited = await listSchedules();
	const first = edited.schedules[0];
	if (!first) throw new Error('Missing fixture schedule');
	first.title = 'Later duty';
	const file = join(fixture.records, 'schedules', 'state.json');
	const previous = await fixture.read('schedules/state.json');
	const replacement = JSON.stringify(edited);
	expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(previous));
	await atomicWrite(file, replacement);
	const replaced = await restSchedules();
	expect(replaced).not.toBe(after);
	expect(replaced.schedules[0]?.title).toBe('Later duty');
});
