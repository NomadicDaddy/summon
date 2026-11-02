import type { TeamAgent } from './types.ts';

/*
 * STATUS UNAVAILABLE: the child is running and this window owns it, but its record could not be
 * read this snapshot. The row stays (so it can still be selected and stopped) and says exactly
 * that; it claims no Ready, no Busy, no task and no phase, because none of those was observed.
 */
export const UNAVAILABLE = 'Status unavailable';
export const UNAVAILABLE_NOTE =
	'The session is running, but its status record could not be read. No status, task or phase is claimed until it reads again.';

/** The marker is a fact about the window's observation of its own running child, nothing else. */
export function observationUnavailable(
	agent: Pick<TeamAgent, 'observationUnavailable' | 'ownedSession' | 'status'>,
): boolean {
	return (
		agent.observationUnavailable === true && agent.status === 'running' && !!agent.ownedSession
	);
}

/**
 * The Maintenance panel's one-line activity summary. A readable row reads exactly as before; an
 * unavailable one names the session state and the label only, because its idle default, task
 * and mail count were omitted by the snapshot rather than observed as zero.
 */
export function activitySummary(
	agent: Pick<
		TeamAgent,
		| 'activity'
		| 'observationUnavailable'
		| 'ownedSession'
		| 'status'
		| 'unreadMail'
		| 'workingOn'
	>,
): string {
	if (observationUnavailable(agent)) return `${agent.status} · ${UNAVAILABLE}`;
	return `${agent.status} · ${agent.activity ?? 'idle'} · ${agent.workingOn || 'No task reported'} · ${agent.unreadMail ?? 0} unread mail`;
}
