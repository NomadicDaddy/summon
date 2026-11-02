import { expect, test } from 'bun:test';

import {
	conditionText,
	dueText,
	intervalText,
	lastRunText,
	spanText,
} from '../src/desktop/schedule-view-text.ts';
import { scheduleView } from '../src/schedule-view.ts';

const now = 1_800_000_000_000;
const minute = 60000;
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const schedule = (n: number, owner: string, dueIn: number, extra: object = {}) => ({
	id: id(n),
	owner,
	title: `Duty ${n}`,
	everyMinutes: 15,
	prompt: 'Fixture scope only.',
	enabled: true,
	nextDueAt: now + dueIn * minute,
	...extra,
});
const run = (n: number, of: number, status: 'complete' | 'delivered' | 'failed', ago: number) => ({
	id: id(100 + n),
	scheduleId: id(of),
	owner: 'x',
	title: 't',
	prompt: 'p',
	dueAt: now - ago * minute,
	updatedAt: now - ago * minute,
	status,
});
const members = [
	{ slug: 'beta', name: 'Beta' },
	{ slug: 'alpha', name: 'Alpha' },
	{ slug: 'idle', name: 'Idle' },
];

test('every schedule is listed under its owner, owners by name, and the rest are named', () => {
	const view = scheduleView(
		{
			version: 1,
			schedules: [schedule(1, 'beta', 5), schedule(2, 'alpha', 5), schedule(3, 'alpha', 1)],
			runs: [],
		},
		members,
		now,
	);
	expect(view.owners.map((owner) => [owner.name, owner.schedules.map((row) => row.id)])).toEqual([
		['Alpha', [id(3), id(2)]],
		['Beta', [id(1)]],
	]);
	expect(view.without).toEqual(['Idle']);
	expect(view.readAt).toBe(now);
});

test('a schedule whose owner is no longer registered keeps its group under the slug', () => {
	const view = scheduleView(
		{ version: 1, schedules: [schedule(1, 'removed', 5)], runs: [] },
		members,
		now,
	);
	expect(view.owners.map((owner) => owner.name)).toEqual(['removed']);
	expect(view.without).toEqual(['Alpha', 'Beta', 'Idle']);
});

test('one condition per schedule: paused, then an unfinished run, then deferred or due', () => {
	const deferred = { reason: 'owner-busy' as const, dueAt: now - minute, observedAt: now };
	const view = scheduleView(
		{
			version: 1,
			schedules: [
				schedule(1, 'alpha', 5),
				schedule(2, 'alpha', -1),
				schedule(3, 'alpha', -1, { deferred }),
				schedule(4, 'alpha', -1, { deferred }),
				schedule(5, 'alpha', -1, { enabled: false, deferred }),
			],
			runs: [run(1, 4, 'delivered', 1), run(2, 1, 'failed', 30), run(3, 1, 'complete', 3)],
		},
		members,
		now,
	);
	const rows = Object.fromEntries(
		view.owners.flatMap((owner) => owner.schedules).map((row) => [row.id, row]),
	);
	expect(rows[id(1)]?.condition).toBe('active');
	expect(rows[id(2)]?.condition).toBe('due');
	expect(rows[id(3)]?.condition).toBe('deferred');
	expect(rows[id(3)]?.deferredReason).toBe('owner-busy');
	expect(rows[id(4)]?.condition).toBe('running');
	expect(rows[id(4)]?.deferredReason).toBeUndefined();
	expect(rows[id(5)]?.condition).toBe('paused');
	// The latest run by time, not by position in the store.
	expect(rows[id(1)]?.lastRun).toEqual({ status: 'complete', updatedAt: now - 3 * minute });
	// Paused schedules sink below the active ones.
	expect(view.owners[0]?.schedules.at(-1)?.id).toBe(id(5));
});

test('the wording a row shows', () => {
	expect([15, 60, 90, 120, 1440, 2880, 10080].map(intervalText)).toEqual([
		'Every 15 min',
		'Every hour',
		'Every 90 min',
		'Every 2 h',
		'Daily',
		'Every 2 days',
		'Weekly',
	]);
	expect([0, 59 * minute, 60 * minute, 47 * 60 * minute, 48 * 60 * minute].map(spanText)).toEqual(
		['0 min', '59 min', '1 h', '47 h', '2 days'],
	);
	const base = {
		id: id(1),
		title: 'Duty',
		prompt: 'p',
		everyMinutes: 15,
		nextDueAt: now + 8 * minute,
	};
	expect(conditionText({ ...base, condition: 'active' })).toBe('Active');
	expect(conditionText({ ...base, condition: 'paused' })).toBe('Paused');
	expect(conditionText({ ...base, condition: 'running' })).toBe('Run in progress');
	expect(conditionText({ ...base, condition: 'due' })).toBe('Due');
	expect(conditionText({ ...base, condition: 'deferred', deferredReason: 'owner-busy' })).toBe(
		'Due, waiting: the owner is busy',
	);
	// A reason this build does not know is shown as recorded, never dropped.
	expect(conditionText({ ...base, condition: 'deferred', deferredReason: 'new-reason' })).toBe(
		'Due, waiting: new-reason',
	);
	expect(dueText({ ...base, condition: 'active' }, now)).toEndWith('(in 8 min)');
	expect(dueText({ ...base, condition: 'active' }, now)).toStartWith('Next ');
	expect(dueText({ ...base, condition: 'due', nextDueAt: now - 3 * minute }, now)).toMatch(
		/^Due since .+ \(3 min\)$/,
	);
	expect(dueText({ ...base, condition: 'paused' }, now)).toBe('No next run while paused');
	expect(lastRunText({ ...base, condition: 'active' })).toBe('No run yet');
	expect(
		lastRunText({
			...base,
			condition: 'active',
			lastRun: { status: 'failed', updatedAt: now },
		}),
	).toStartWith('Last run failed, ');
});

test('a run with uncertain delivery stops its schedule and is not shown as in progress', () => {
	const uncertain = { ...run(1, 1, 'delivered', 2), status: 'uncertain' as const };
	const view = scheduleView(
		{
			version: 1,
			schedules: [schedule(1, 'alpha', -5), schedule(2, 'alpha', -5, { enabled: false })],
			runs: [
				uncertain,
				run(2, 1, 'delivered', 1),
				{ ...uncertain, id: id(103), scheduleId: id(2) },
			],
		},
		members,
		now,
	);
	const [stalled, paused] = view.owners[0]?.schedules ?? [];
	// Ahead of an ordinary unfinished run on the same schedule, behind a deliberate pause.
	expect(stalled?.condition).toBe('stalled');
	expect(paused?.condition).toBe('paused');
	if (!stalled) throw new Error('Missing row.');
	expect(conditionText(stalled)).toBe('Stopped: a run’s delivery is uncertain');
});
