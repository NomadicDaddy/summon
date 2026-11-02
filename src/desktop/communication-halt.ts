import type { CommunicationAttribution, CommunicationStatus } from '../communication-state.ts';

import { faultText, reportFault } from './fault-report.ts';
import { readableError } from './ipc-error.ts';

/*
 * THE COMMUNICATIONS HALT BANNER sits in <main>, above the toolbar, so it is on screen whichever
 * tab or panel is open: a halt stops every teammate's mail, Room and Telegram sends, and before it
 * the only trace was one status line inside the Room panel, which is closed most of the time.
 *
 * It is not Hold Interruptions. That control quiets notifications for the operator; this one names
 * a halt of the whole team's sending. Separate element, wording and state; neither reads the other.
 *
 * Attribution is shown exactly as recorded. A halt written before attribution existed has none,
 * and the banner says so instead of naming anybody (#15563).
 */

/** Who halted and from where, or null when that was not recorded. */
export function haltActor(attribution: CommunicationAttribution | null): string | null {
	if (!attribution) return null;
	switch (attribution.channel) {
		case 'cli':
			return 'by you from the command line';
		case 'team-room':
			return 'by you from the Team Room';
		case 'telegram':
			return `by Telegram user ${attribution.actor.id}`;
	}
}

/**
 * The change time on the local clock, with the date when it was not today and the year when it was
 * not this year. Days compare with their year, or a pause from this date last year reads as today.
 */
export function haltTime(changedAt: number, now: number, timeZone?: string): string {
	const zone = timeZone ? { timeZone } : {};
	const format = (options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat =>
		new Intl.DateTimeFormat('en-US', { ...options, ...zone });
	const day = format({ day: 'numeric', month: 'short' });
	const fullDay = format({ day: 'numeric', month: 'short', year: 'numeric' });
	const year = format({ year: 'numeric' });
	const time = format({ hour: '2-digit', hourCycle: 'h23', minute: '2-digit' }).format(changedAt);
	if (fullDay.format(changedAt) === fullDay.format(now)) return time;
	const sameYear = year.format(changedAt) === year.format(now);
	return `${(sameYear ? day : fullDay).format(changedAt)} ${time}`;
}

/** The banner sentence for a paused status; null while communications are open. */
export function haltText(
	status: CommunicationStatus,
	now: number,
	timeZone?: string,
): string | null {
	if (!status.paused) return null;
	const when = haltTime(status.changedAt, now, timeZone);
	const actor = haltActor(status.attribution);
	const lead = actor
		? `Communications halted at ${when} ${actor}.`
		: `Communications halted at ${when}. Who halted them was not recorded.`;
	return `${lead} Teammates cannot send mail, Room posts or Telegram messages until you proceed.`;
}

export function setupCommunicationHalt(): (status: CommunicationStatus) => void {
	const get = (id: string): HTMLElement => {
		const node = document.getElementById(id);
		if (!node) throw new Error(`Missing halt element ${id}`);
		return node;
	};
	const banner = get('comms-halt');
	const text = get('comms-halt-text');
	const error = get('comms-halt-error');
	const proceed = get('comms-halt-proceed') as HTMLButtonElement;
	// Proceed is the operator's own Room post, so it takes the same path as typing it and leaves
	// the same record in the conversation.
	proceed.addEventListener('click', () => {
		proceed.disabled = true;
		error.hidden = true;
		void window.team
			.roomSend('proceed', null)
			.catch((cause: unknown) => {
				error.textContent = readableError(cause);
				error.hidden = false;
				reportFault({
					level: 'error',
					source: 'comms-halt.proceed',
					text: faultText(cause),
				});
			})
			.finally(() => {
				proceed.disabled = false;
			});
	});
	return (status) => {
		const sentence = haltText(status, Date.now());
		banner.hidden = sentence === null;
		if (sentence === null) error.hidden = true;
		else if (text.textContent !== sentence) text.textContent = sentence;
	};
}
