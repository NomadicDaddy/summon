import type { listSchedules } from './schedules.ts';

type State = Awaited<ReturnType<typeof listSchedules>>;
type Schedule = State['schedules'][number];
type Run = State['runs'][number];

/** What one schedule is doing right now. Exactly one applies, in this order of precedence. */
export type ScheduleCondition = 'paused' | 'stalled' | 'running' | 'deferred' | 'due' | 'active';

export interface ScheduleRow {
	id: string;
	title: string;
	prompt: string;
	everyMinutes: number;
	condition: ScheduleCondition;
	/** Why a due schedule has not been delivered; only with `deferred`. */
	deferredReason?: string;
	nextDueAt: number;
	/** The most recently updated run, finished or not. */
	lastRun?: { status: Run['status']; updatedAt: number; result?: string };
}

export interface ScheduleOwner {
	slug: string;
	name: string;
	schedules: ScheduleRow[];
}

export interface ScheduleView {
	readAt: number;
	owners: ScheduleOwner[];
	/** Registered teammates who own no schedule, by display name. */
	without: string[];
}

const finished = (run: Run): boolean => run.status === 'complete' || run.status === 'failed';

function row(schedule: Schedule, runs: Run[], now: number): ScheduleRow {
	const own = runs.filter((run) => run.scheduleId === schedule.id);
	const last = own.reduce<Run | undefined>(
		(latest, run) => (!latest || run.updatedAt > latest.updatedAt ? run : latest),
		undefined,
	);
	let condition: ScheduleCondition = 'active';
	if (!schedule.enabled) condition = 'paused';
	// A run whose delivery is uncertain holds its schedule until someone settles it, so it is not
	// "in progress": nothing is known to be happening.
	else if (own.some((run) => run.status === 'uncertain')) condition = 'stalled';
	else if (own.some((run) => !finished(run))) condition = 'running';
	else if (schedule.nextDueAt <= now) condition = schedule.deferred ? 'deferred' : 'due';
	return {
		id: schedule.id,
		title: schedule.title,
		prompt: schedule.prompt,
		everyMinutes: schedule.everyMinutes,
		condition,
		...(condition === 'deferred' && schedule.deferred
			? { deferredReason: schedule.deferred.reason }
			: {}),
		nextDueAt: schedule.nextDueAt,
		...(last
			? {
					lastRun: {
						status: last.status,
						updatedAt: last.updatedAt,
						...(last.result === undefined ? {} : { result: last.result }),
					},
				}
			: {}),
	};
}

/**
 * Every schedule in the store, grouped by owner, for the Team Window's read-only view.
 *
 * `members` is the registered roster. An owner no longer on it keeps its group under its slug, so a
 * schedule left behind by a removed teammate stays visible instead of vanishing from the one place
 * that lists them all.
 */
export function scheduleView(
	state: State,
	members: { slug: string; name: string }[],
	now = Date.now(),
): ScheduleView {
	const names = new Map(members.map((member) => [member.slug, member.name]));
	const groups = new Map<string, ScheduleRow[]>();
	for (const schedule of state.schedules) {
		const rows = groups.get(schedule.owner) ?? [];
		rows.push(row(schedule, state.runs, now));
		groups.set(schedule.owner, rows);
	}
	const owners = [...groups]
		.map(([slug, schedules]) => ({
			slug,
			name: names.get(slug) ?? slug,
			// Active work first, paused last; inside each, the soonest due first.
			schedules: schedules.sort(
				(a, b) =>
					Number(a.condition === 'paused') - Number(b.condition === 'paused') ||
					a.nextDueAt - b.nextDueAt,
			),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	return {
		readAt: now,
		owners,
		without: members
			.filter((member) => !groups.has(member.slug))
			.map((member) => member.name)
			.sort((a, b) => a.localeCompare(b)),
	};
}
