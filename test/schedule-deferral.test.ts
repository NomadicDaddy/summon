import { afterEach, beforeEach, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { setCommunicationPause } from '../src/communication-state.ts';
import { setHibernation } from '../src/hibernation.ts';
import {
	createSchedule,
	dispatchSchedules,
	enableSchedule,
	finishScheduledRun,
	listSchedules,
} from '../src/schedules.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous === undefined) Reflect.deleteProperty(process.env, 'SUMMON_HOME');
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});
async function due() {
	const item = await createSchedule({
		owner: 'alpha',
		title: 'Review',
		everyMinutes: 1,
		prompt: 'Fixture scope only.',
	});
	const state = await listSchedules();
	const schedule = state.schedules[0];
	if (!schedule) throw new Error('Missing schedule');
	schedule.nextDueAt = 0;
	await writeFile(join(fixture.records, 'schedules/state.json'), JSON.stringify(state));
	return item.id;
}
const noNotify = () => Promise.resolve();

test('deferral is visible to owner CLI, retains due work, and clears before one eligible delivery', async () => {
	const id = await due();
	let eligible = false;
	let calls = 0;
	const availability = () => {
		calls++;
		return Promise.resolve(eligible);
	};
	await dispatchSchedules(availability, noNotify, 100);
	await dispatchSchedules(availability, noNotify, 200);
	let state = await listSchedules();
	expect(state.schedules[0]?.deferred).toEqual({
		reason: 'owner-unavailable',
		dueAt: 0,
		observedAt: 100,
	});
	expect(state.schedules[0]?.nextDueAt).toBe(0);
	expect(state.runs).toHaveLength(0);
	const owner = await fixture.run(['--schedule', 'list'], 'alpha');
	expect(owner.code).toBe(0);
	expect(owner.out).toContain('owner-unavailable');
	expect((await fixture.run(['--schedule', 'list'], 'beta')).out).not.toContain(id);
	eligible = true;
	await dispatchSchedules(availability, noNotify, 300);
	state = await listSchedules();
	expect(state.runs).toHaveLength(1);
	expect(state.schedules[0]?.deferred).toBeUndefined();
	expect(state.schedules[0]?.nextDueAt).toBe(60000);
	await dispatchSchedules(availability, noNotify, 60400);
	expect((await listSchedules()).schedules[0]?.deferred?.reason).toBe('unfinished-run');
	expect(calls).toBe(3);
	const run = state.runs[0];
	if (!run) throw new Error('Missing run');
	await finishScheduledRun(run.id, 'complete', 'Fixture evidence');
	await dispatchSchedules(availability, noNotify, 60400);
	expect((await listSchedules()).runs).toHaveLength(2);
});

test('pause and hibernation explain due work without calling availability or delivering', async () => {
	const id = await due();
	const unexpected = () => {
		throw new Error('Availability must not run');
	};
	await setCommunicationPause(true);
	await dispatchSchedules(unexpected, noNotify, 100);
	expect((await listSchedules()).schedules[0]?.deferred?.reason).toBe('communications-paused');
	await setCommunicationPause(false);
	await setHibernation('alpha', true);
	await dispatchSchedules(unexpected, noNotify, 200);
	expect((await listSchedules()).schedules[0]?.deferred?.reason).toBe('hibernated');
	expect((await listSchedules()).runs).toHaveLength(0);
	await enableSchedule(id, false);
	expect((await listSchedules()).schedules[0]?.deferred).toBeUndefined();
});
