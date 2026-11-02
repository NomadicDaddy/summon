import type { ScheduleRow } from '../schedule-view.ts';

/** "Every 15 min", "Every hour", "Daily", "Weekly": the interval as a person would say it. */
export function intervalText(everyMinutes: number): string {
	if (everyMinutes === 60) return 'Every hour';
	if (everyMinutes === 1440) return 'Daily';
	if (everyMinutes === 10080) return 'Weekly';
	if (everyMinutes % 1440 === 0) return `Every ${everyMinutes / 1440} days`;
	if (everyMinutes % 60 === 0) return `Every ${everyMinutes / 60} h`;
	return `Every ${everyMinutes} min`;
}

/** A whole number of minutes, hours or days, largest unit that fits: "38 min", "3 h", "2 days". */
export function spanText(milliseconds: number): string {
	const minutes = Math.floor(Math.abs(milliseconds) / 60000);
	if (minutes < 60) return `${minutes} min`;
	if (minutes < 2880) return `${Math.floor(minutes / 60)} h`;
	return `${Math.floor(minutes / 1440)} days`;
}

const deferrals: Record<string, string> = {
	'communications-paused': 'communications are paused',
	hibernated: 'the owner is hibernated',
	'owner-missing': 'the owner is not registered',
	'unfinished-run': 'an earlier run is unfinished',
	'operator-viewing': 'you are viewing their terminal',
	'head-down': 'the owner is head-down',
	'window-closing': 'the Team Window is closing',
	'not-running-here': 'the owner is not running here',
	'owner-busy': 'the owner is busy',
	'owner-needs-user': 'the owner is waiting on you',
	'activity-unknown': "the owner's activity is unknown",
	'owner-unavailable': 'the owner is unavailable',
};

/** The one-word state shown beside the title, with the reason a due schedule is still waiting. */
export function conditionText(row: ScheduleRow): string {
	if (row.condition === 'paused') return 'Paused';
	if (row.condition === 'stalled') return 'Stopped: a run’s delivery is uncertain';
	if (row.condition === 'running') return 'Run in progress';
	if (row.condition === 'due') return 'Due';
	if (row.condition === 'deferred')
		return `Due, waiting: ${deferrals[row.deferredReason ?? ''] ?? row.deferredReason ?? 'reason not recorded'}`;
	return 'Active';
}

const clock = (time: number): string =>
	new Date(time).toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});

/** When it next runs, or how long it has been due. A paused schedule has no next run. */
export function dueText(row: ScheduleRow, now: number): string {
	if (row.condition === 'paused') return 'No next run while paused';
	const span = spanText(row.nextDueAt - now);
	return row.nextDueAt > now
		? `Next ${clock(row.nextDueAt)} (in ${span})`
		: `Due since ${clock(row.nextDueAt)} (${span})`;
}

const outcomes: Record<NonNullable<ScheduleRow['lastRun']>['status'], string> = {
	dispatching: 'being delivered',
	delivered: 'delivered, not finished',
	uncertain: 'delivery uncertain',
	complete: 'complete',
	failed: 'failed',
};

export function lastRunText(row: ScheduleRow): string {
	return row.lastRun
		? `Last run ${outcomes[row.lastRun.status]}, ${clock(row.lastRun.updatedAt)}`
		: 'No run yet';
}
