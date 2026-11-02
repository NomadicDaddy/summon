import type { listSchedules } from './schedules.ts';

type State = Awaited<ReturnType<typeof listSchedules>>;
const LIMIT = 20;

const localTime = (time: number): string => {
	const date = new Date(time);
	if (!Number.isFinite(date.getTime())) return `Unrepresentable timestamp: ${time}`;
	return new Intl.DateTimeFormat('en-CA', {
		dateStyle: 'short',
		timeStyle: 'long',
		hourCycle: 'h23',
	}).format(date);
};

/** Shared diagnosis for the own-work view, schedule CLI and existing rest gate. */
export function summarizeSchedules(state: State, now = Date.now()) {
	const unfinished = state.runs.filter((run) => !['complete', 'failed'].includes(run.status));
	const due = state.schedules.filter((schedule) => schedule.enabled && schedule.nextDueAt <= now);
	const next = state.schedules
		.filter((item) => item.enabled && item.nextDueAt > now)
		.sort((a, b) => a.nextDueAt - b.nextDueAt);
	const paused = state.schedules.filter((item) => !item.enabled);
	return {
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		counts: {
			unfinished: unfinished.length,
			due: due.length,
			next: next.length,
			paused: paused.length,
		},
		limitPerSection: LIMIT,
		inspectAll: 'summon --schedule list',
		unfinished: unfinished
			.slice(0, LIMIT)
			.map(({ id, scheduleId, owner, title, status, dueAt, updatedAt }) => ({
				id,
				scheduleId,
				owner,
				title,
				status,
				dueAt,
				updatedAt,
				dueLocal: localTime(dueAt),
			})),
		due: due.slice(0, LIMIT).map(({ id, owner, title, nextDueAt, deferred }) => ({
			id,
			owner,
			title,
			nextDueAt,
			dueLocal: localTime(nextDueAt),
			deferred: deferred ?? null,
			unfinishedRunIds: unfinished
				.filter((run) => run.scheduleId === id)
				.slice(0, LIMIT)
				.map((run) => run.id),
		})),
		next: next.slice(0, LIMIT).map(({ id, owner, title, nextDueAt }) => ({
			id,
			owner,
			title,
			nextDueAt,
			dueLocal: localTime(nextDueAt),
		})),
		paused: paused.slice(0, LIMIT).map(({ id, owner, title }) => ({ id, owner, title })),
	};
}

export function scheduledRestReason(state: State, name: string, now = Date.now()): string {
	const run = state.runs.find(
		(item) => item.owner === name && !['complete', 'failed'].includes(item.status),
	);
	if (run)
		return `Scheduled run ${run.id} (${run.status}) needs attention; inspect summon --schedule run ${run.id}`;
	const due = state.schedules.find(
		(item) => item.owner === name && item.enabled && item.nextDueAt <= now,
	);
	return due
		? `Scheduled work ${due.id} is due${due.deferred ? `; deferred: ${due.deferred.reason}` : ''}; inspect summon --schedule summary`
		: '';
}
