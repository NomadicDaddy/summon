import type { HeadDownView } from '../head-down-model.ts';

export interface HeadDownRow {
	/** Set on the row so the stylesheet can mark it; absent when the teammate is not in head-down. */
	phase?: 'active' | 'requested';
	/** Whether the dot takes the roster's existing red. */
	overdue: boolean;
	/** What the second line of the row says. */
	line: string;
}

/**
 * The roster's head-down rules, kept apart from the DOM so they can be tested as rules.
 *
 * All three are decisions Phillip approved at #4558 rather than anything about markup, and each one
 * exists because the obvious alternative is wrong:
 *
 * The GOAL REPLACES the self-written status when head-down is active. The column is 252px and will
 * not carry both; of the two, the goal is the one the operator agreed to.
 *
 * OVERDUE IS SUPPRESSED when the session has exited. Both want the roster's red and they mean
 * nearly the same thing to a reader, but exited is terminal and overdue is only a report that
 * stopped arriving - so the terminal fact wins and the status text says which.
 *
 * A REQUEST CHANGES NEITHER the colour nor the line. It is a question waiting for an answer, not a
 * state the session is in: the teammate is still running or idle or stopped underneath, and the
 * roster has to keep saying which.
 */
export function headDownRow(
	status: string,
	self: string,
	headDown: HeadDownView | undefined,
): HeadDownRow {
	if (!headDown) return { line: self, overdue: false };
	const active = headDown.phase === 'active';
	return {
		line: active ? headDown.goal : self,
		overdue: active && headDown.overdue && status !== 'exited',
		phase: headDown.phase,
	};
}

/**
 * What an open End-reason editor belongs to: one teammate, one approved goal.
 *
 * The editor used to be dismissed only when head-down went away entirely, which misses the case
 * that matters. Switching from one teammate in head-down to ANOTHER one in head-down leaves the
 * state "active" throughout, so a reason typed about the first goal stayed on screen over the
 * second - and confirming it would have ended the second teammate's head-down with words written
 * about someone else's work. Morgan found it at 9c8b8c79.
 *
 * Keying on the goal id as well as the slug matters: one teammate can end a head-down and begin
 * another without the selection changing at all, and a draft must not survive that either.
 */
export function headDownEditorKey(
	slug: string | undefined,
	headDown: HeadDownView | undefined,
): string {
	return slug && headDown?.phase === 'active' ? `${slug}:${headDown.id}` : '';
}

/**
 * Whether the quiet-time control has anything to offer for this teammate.
 *
 * The backend will not start or hold a pause for a session this window is not running, which is
 * right - there are no notifications to hold for a session that is not there. But the button went
 * on being shown and pressed, and pressing it did nothing at all: it offered an action it would
 * never perform, which is the same defect as a thumbs-up that silently swallows a second press
 * without saying so.
 *
 * The two conditions mirror the backend's own rule rather than guessing at it. Running elsewhere
 * is deliberately excluded: that window owns the session's quiet time, and this one cannot speak
 * for it.
 */
/** Whether an approved head-down is running for this teammate, which queues its notices by itself. */
export function isHeadsDown(agent: { headDown?: { phase: string } } | undefined): boolean {
	return agent?.headDown?.phase === 'active';
}

export function canPauseNotifications(
	agent: { ownedSession?: boolean; status: string } | undefined,
): boolean {
	return agent?.status === 'running' && agent.ownedSession === true;
}
