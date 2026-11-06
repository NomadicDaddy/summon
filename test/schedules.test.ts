import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { setCommunicationPause } from '../src/communication-state.ts';
import { tickSchedules } from '../src/desktop/schedules.ts';
import { Team } from '../src/desktop/team.ts';
import { setHibernation } from '../src/hibernation.ts';
import { acknowledgeMessage } from '../src/mailbox.ts';
import {
	createSchedule,
	dispatchSchedules,
	finishScheduledRun,
	listSchedules,
} from '../src/schedules.ts';
import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { attachFixtureReceiver, waitForNotice } from './fixtures/wake-team.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
function first<T>(items: T[]): T {
	const item = items[0];
	if (!item) throw new Error('Expected fixture item');
	return item;
}
async function rejects(promise: Promise<unknown>, message = ''): Promise<void> {
	const result: unknown = await promise.catch((error: unknown) => error);
	expect(result).toBeInstanceOf(Error);
	if (result instanceof Error) expect(result.message).toContain(message);
}
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
const input = {
	owner: 'alpha',
	title: 'Review',
	everyMinutes: 1,
	prompt: 'Review only fixture changes.',
};
const dispatch = (now: number) =>
	dispatchSchedules(
		() => Promise.resolve(true),
		() => Promise.resolve(),
		now,
	);

test('separate processes claim one occurrence; receipt is not completion; overdue intervals coalesce', async () => {
	const schedule = await createSchedule(input);
	const now = schedule.nextDueAt + 600123;
	const children = [1, 2, 3].map(() =>
		Bun.spawn({
			cmd: [
				process.execPath,
				join(import.meta.dir, 'fixtures/schedule-dispatch.ts'),
				String(now),
			],
			env: { ...process.env, SUMMON_HOME: fixture.records },
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
		}),
	);
	for (const child of children) {
		const error = await new Response(child.stderr).text();
		expect({ code: await child.exited, error }).toEqual({ code: 0, error: '' });
	}
	let state = await listSchedules();
	expect(state.runs).toHaveLength(1);
	expect(first(state.runs).status).toBe('delivered');
	expect(first(state.runs).dueAt).toBe(schedule.nextDueAt);
	expect(first(state.schedules).nextDueAt).toBe(schedule.nextDueAt + 660000);
	expect(await readdir(join(fixture.records, 'mailboxes/alpha/inbox'))).toHaveLength(1);
	await acknowledgeMessage('alpha', first(state.runs).id);
	await dispatch(now + 600000);
	expect((await listSchedules()).runs).toHaveLength(1);
	const id = first(state.runs).id;
	expect((await fixture.run(['--schedule', 'run', id], 'beta')).code).toBe(1);
	expect((await fixture.run(['--schedule', 'complete', id, 'wrong owner'], 'beta')).code).toBe(1);
	expect(
		(await fixture.run(['--schedule', 'complete', id, 'Verified fixture'], 'alpha')).code,
	).toBe(0);
	await rejects(finishScheduledRun(id, 'failed', 'overwrite'), 'immutable');
	await dispatch(now + 600000);
	state = await listSchedules();
	expect(state.runs).toHaveLength(2);
	expect(first(state.runs).result).toBe('Verified fixture');
});

test('late daily dispatch keeps the original phase after deferral and at an exact boundary', async () => {
	const schedule = await createSchedule({ ...input, everyMinutes: 1440 });
	const day = 1440 * 60000;
	const late = schedule.nextDueAt + 8 * 60 * 60000 + 12345;
	await dispatchSchedules(
		() => Promise.resolve(false),
		() => Promise.resolve(),
		late,
	);
	expect(first((await listSchedules()).schedules).nextDueAt).toBe(schedule.nextDueAt);
	await dispatch(late);
	let state = await listSchedules();
	expect(first(state.runs).dueAt).toBe(schedule.nextDueAt);
	expect(first(state.schedules).nextDueAt).toBe(schedule.nextDueAt + day);
	await finishScheduledRun(first(state.runs).id, 'complete', 'Fixture evidence');
	await dispatch(schedule.nextDueAt + day);
	state = await listSchedules();
	expect(state.runs).toHaveLength(2);
	expect(first(state.schedules).nextDueAt).toBe(schedule.nextDueAt + 2 * day);
});

test('delivery failure stays uncertain and empty storage fails closed without overwriting history', async () => {
	const schedule = await createSchedule(input);
	await mkdir(join(fixture.records, 'mailboxes/alpha'), { recursive: true });
	await writeFile(
		join(fixture.records, 'mailboxes/alpha/inbox'),
		'Deliberately blocked fixture path',
	);
	await rejects(dispatch(schedule.nextDueAt), 'uncertain delivery');
	expect(first((await listSchedules()).runs).status).toBe('uncertain');
	await dispatch(schedule.nextDueAt + 60000);
	expect((await listSchedules()).runs).toHaveLength(1);
	await writeFile(join(fixture.records, 'schedules/state.json'), '');
	await rejects(createSchedule(input));
	expect(await fixture.read('schedules/state.json')).toBe('');
});

test('owner controls, stopped eligibility, hibernation, and pause preserve due work', async () => {
	expect(
		(
			await fixture.run(['--schedule', 'create', JSON.stringify(input)], 'alpha', {
				SUMMON_NONCE: '',
			})
		).code,
	).toBe(1);
	expect((await fixture.run(['--schedule', 'create', JSON.stringify(input)], 'alpha')).code).toBe(
		0,
	);
	expect((await fixture.run(['--schedule', 'create', JSON.stringify(input)], 'beta')).code).toBe(
		1,
	);
	await rejects(createSchedule({ ...input, everyMinutes: 0 }));
	await rejects(createSchedule({ ...input, owner: 'missing' }), 'Unknown');
	const schedule = first((await listSchedules()).schedules);
	expect((await fixture.run(['--schedule', 'pause', schedule.id])).code).toBe(0);
	expect((await fixture.run(['--schedule', 'resume', schedule.id])).code).toBe(0);
	expect((await fixture.run(['--schedule', 'pause', schedule.id], 'beta')).code).toBe(1);
	expect((await fixture.run(['--schedule', 'resume', schedule.id], 'beta')).code).toBe(1);
	await dispatchSchedules(
		() => Promise.resolve(false),
		() => Promise.reject(new Error('unexpected')),
		schedule.nextDueAt,
	);
	await setHibernation('alpha', true);
	await dispatch(schedule.nextDueAt);
	await setHibernation('alpha', false);
	await setCommunicationPause(true);
	await dispatch(schedule.nextDueAt);
	await setCommunicationPause(false);
	expect((await listSchedules()).runs).toHaveLength(0);
	expect((await fixture.run(['--schedule', 'pause', schedule.id], 'alpha')).code).toBe(0);
	await dispatch(schedule.nextDueAt);
	expect((await listSchedules()).runs).toHaveLength(0);
	expect((await fixture.run(['--schedule', 'resume', schedule.id], 'alpha')).code).toBe(0);
	await dispatch(schedule.nextDueAt);
	expect((await listSchedules()).runs).toHaveLength(1);
	const hidden = await fixture.run(['--schedule', 'list'], 'beta');
	expect((JSON.parse(hidden.out) as { runs: unknown[] }).runs).toHaveLength(0);
});

test('interrupted claims become uncertain and notification failure never redelivers', async () => {
	const schedule = await createSchedule(input);
	await rejects(
		dispatchSchedules(
			() => Promise.resolve(true),
			() => Promise.reject(new Error('terminal lost')),
			schedule.nextDueAt,
		),
		'notification failed',
	);
	await dispatch(schedule.nextDueAt + 600000);
	const state = await listSchedules();
	expect(state.runs).toHaveLength(1);
	first(state.runs).status = 'dispatching';
	await writeFile(join(fixture.records, 'schedules/state.json'), JSON.stringify(state));
	await rejects(dispatch(schedule.nextDueAt + 600000), 'interrupted delivery');
	await dispatch(schedule.nextDueAt + 600000);
	expect(first((await listSchedules()).runs).status).toBe('uncertain');
	expect(await readdir(join(fixture.records, 'mailboxes/alpha/inbox'))).toHaveLength(1);
});

test('desktop tick targets the named running idle Kilo terminal, never an adjacent same-directory agent', async () => {
	await writeFile(
		join(fixture.records, 'alpha.json'),
		JSON.stringify(newRecord('alpha', fixture.root, 'kilo')),
	);
	await rm(join(fixture.records, 'runtime/alpha/activity.json'));
	const inputs: string[] = [];
	const exits: ((event: { exitCode: number }) => void)[] = [];
	let launches = 0;
	const team = new Team(
		'bun',
		'cli.ts',
		() => {},
		() => {
			launches++;
			return {
				pid: 1,
				onData: () => ({ dispose() {} }),
				onExit: (listener) => {
					exits.push(listener);
					return { dispose() {} };
				},
				write: (value) => {
					inputs.push(String(value));
				},
				resize() {},
				kill() {},
			};
		},
	);
	await createSchedule(input);
	const state = await listSchedules();
	first(state.schedules).nextDueAt = 0;
	await writeFile(join(fixture.records, 'schedules/state.json'), JSON.stringify(state));
	await tickSchedules(team);
	expect(launches).toBe(0);
	expect(first((await listSchedules()).schedules).deferred?.reason).toBe('not-running-here');
	await team.start('beta');
	await tickSchedules(team);
	expect(inputs).toHaveLength(0);
	await team.start('alpha');
	await tickSchedules(team);
	expect((await listSchedules()).runs).toHaveLength(0);
	expect(first((await listSchedules()).schedules).deferred?.reason).toBe('activity-unknown');
	await initializeActivity('alpha', 'fixture');
	const activity = join(fixture.records, 'runtime/alpha/activity.json');
	const record = JSON.parse(await fixture.read('runtime/alpha/activity.json')) as Record<
		string,
		unknown
	>;
	for (const state of ['busy', 'needs-user'] as const) {
		await writeFile(activity, JSON.stringify({ ...record, state }));
		await tickSchedules(team);
		expect(first((await listSchedules()).schedules).deferred?.reason).toBe(`owner-${state}`);
	}
	expect(inputs).toHaveLength(0);
	await writeFile(activity, JSON.stringify(record));
	await tickSchedules(team);
	const stop = await attachFixtureReceiver(team, 'alpha');
	try {
		await waitForNotice(inputs, '1 new mailbox event');
		expect(inputs).toHaveLength(1);
		const dispatched = await listSchedules();
		expect(first(dispatched.schedules).deferred).toBeUndefined();
		expect(
			await fixture.read(`mailboxes/alpha/inbox/${first(dispatched.runs).id}.md`),
		).toContain(`summon --schedule run ${first(dispatched.runs).id}`);
		expect(first(dispatched.schedules).prompt).toBe(input.prompt);
		expect(launches).toBe(2);
		team.closing = true;
		await tickSchedules(team);
		expect(inputs).toHaveLength(1);
	} finally {
		await stop();
		for (const exit of exits) exit({ exitCode: 0 });
		await team.shutdown();
	}
});
