export interface NotificationPauseView {
	paused: boolean;
	manual: boolean;
	until?: number;
}

/** The operator's preference for the automatic hold (team settings autoHold and holdSeconds). */
export interface HoldPolicy {
	autoHold: boolean;
	holdMs: number;
}

export const DEFAULT_HOLD_POLICY: HoldPolicy = { autoHold: true, holdMs: 30_000 };

/**
 * Operator-selected quiet time, unrelated to task deadlines or approved head-down work.
 *
 * ONE PAUSE, BELONGING TO WHOEVER IS SELECTED - not one per teammate, and switching does not stash
 * the old one. Selecting someone else drops the previous name's quiet window AND any held pause,
 * and starts a fresh window on the new name.
 *
 * WHICH DIRECTION IT RUNS, because I got this backwards first and the name does not settle it.
 * Pausing stops AUTOMATIC INTERRUPTIONS REACHING THE TEAMMATE - live room notices, wakes, schedules
 * and rest nudges - while the operator has them selected. It is not about quieting a teammate that
 * is bothering the operator. automaticInterruptionsPaused() is the consumer; follow it to
 * local-room-live, team-wakes, schedules and rest for what is actually suppressed, and note that it
 * consumes nothing: senders keep their messages for catch-up.
 *
 * THAT IS WHY IT FOLLOWS THE SELECTION rather than sticking to a teammate, and why dropping a held
 * pause on switch is correct. Phillip at #4846: the point is that whoever he is talking to directly
 * is not interrupted mid-conversation. Protecting a conversation he has walked away from would be
 * solving a problem he does not have, and would need roster marks to stay visible - which is #4573
 * growing back in a new costume.
 *
 * So the scope of a pause is the conversation, not the teammate. Before changing that, re-read this:
 * the behaviour looks wrong from the code and is right from the chair.
 *
 * The automatic window follows `policy` (Phillip #7266): off, selecting and typing hold nothing and
 * only the pinned pause remains; on, its length is the operator's chosen seconds.
 *
 * Only the operator's own input in that teammate's terminal renews it (Phillip #13984, pane only):
 * typing in the Room, Board, notepad or Maintenance is not talking to them, and a terminal's
 * automatic replies (focus, mouse and query reports) are not the operator at all.
 */
export function notificationPause(
	clock = Date.now,
	policy: () => HoldPolicy = () => DEFAULT_HOLD_POLICY,
): {
	select: (name: string, running: boolean) => void;
	terminalInput: (name: string, humanInput: boolean) => void;
	set: (paused: boolean) => void;
	view: () => NotificationPauseView;
} {
	let selected = '';
	let manual = false;
	let until = 0;
	const renew = (): void => {
		const { autoHold, holdMs } = policy();
		until = autoHold ? clock() + holdMs : 0;
	};
	return {
		select: (name, running) => {
			if (!running) name = '';
			if (name === selected) return;
			selected = name;
			manual = false;
			if (name) renew();
			else until = 0;
		},
		terminalInput: (name, humanInput) => {
			if (humanInput && name && name === selected && !manual) renew();
		},
		set: (paused) => {
			manual = Boolean(selected) && paused;
			until = 0;
		},
		view: () => {
			// A policy switched off releases a running countdown at once; reading it never renews.
			const automatic = policy().autoHold && until > clock();
			return {
				paused: manual || automatic,
				manual,
				...(!manual && automatic ? { until } : {}),
			};
		},
	};
}
