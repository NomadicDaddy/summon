import { readActivity } from './agent-activity.ts';
import { readBoard } from './board.ts';
import { catchUpPending } from './checkpoint-skip-progress.ts';
import { cachedLocalEvents } from './local-room.ts';
import { ownHolds } from './mail-attention.ts';
import { optionalText } from './mail-files.ts';
import { header, statePath } from './mail-read.ts';
import { pendingMessages } from './mailbox.ts';
import { localCursorPath, roomCursor } from './room-cursor.ts';
import { addressedTo, addressedToStopped } from './room-wake.ts';
import { scheduledRestReason } from './schedule-summary.ts';
import { listSchedules } from './schedules.ts';

/**
 * Why `name` cannot rest now, or '' when it can.
 * @param since Room id the addressed-message check starts after; the read cursor when omitted.
 * @param idleIsSetNext The explicit command settles idle or preserves the existing human wait
 *   only after every other reason passes, so a refusal leaves the status untouched.
 * @param waitingActivity Exact human-wait snapshot bound to an existing explicit confirmation.
 * @param stopped The session is stopped for rest, so an addressed message would start it; only
 *   messages that may start a stopped seat count (addressedToStopped).
 */
export async function restEvidence(
	name: string,
	since?: number,
	idleIsSetNext = false,
	waitingActivity?: string,
	stopped = false,
	waitingScheduleIds?: string[],
) {
	const cards = (await readBoard()).items.filter((item) => item.owner === name && !item.archived);
	const board = JSON.stringify({
		cards: cards.map((item) => [item.id, item.revision]),
		decisions: (await ownHolds(name)).map((hold) => [hold.id, hold.decision]),
	});
	const history = await cachedLocalEvents();
	const own = new Set(
		history
			.filter((event) => event.sender.kind === 'agent' && event.sender.id === name)
			.map((event) => event.id),
	);
	const after = since ?? roomCursor((await optionalText(localCursorPath(name))) ?? '0');
	const addressed = history.find(
		(event) =>
			event.id > after &&
			!(event.sender.kind === 'agent' && event.sender.id === name) &&
			((stopped ? addressedToStopped(event, name) : addressedTo(event, name)) ||
				(event.replyTo !== null && own.has(event.replyTo))),
	);
	let mail = false;
	for (const file of await pendingMessages(name)) {
		const id = file.slice(0, -3);
		// Covered mail cannot be unread work; avoid reopening every retained header under the lock.
		if (await optionalText(statePath(name, id, 'read'))) continue;
		// These are protocol bookkeeping, retained for the next ordinary read, not new work.
		const item = await header(name, id);
		if (
			['receipt', 'confirmation', 'rest-ready'].includes(item.kind) ||
			item.noticeStatus === 'obsolete'
		)
			continue;
		mail = true;
		break;
	}
	const activity = await readActivity(name);
	const activityPermitsRest =
		waitingActivity === undefined
			? activity?.state === 'idle'
			: activity?.state === 'needs-user' && JSON.stringify(activity) === waitingActivity;
	const schedules = await listSchedules();
	const now = Date.now();
	const dueScheduleIds = schedules.schedules
		.filter((item) => item.owner === name && item.enabled && item.nextDueAt <= now)
		.map((item) => item.id);
	const humanWait =
		activity?.state === 'needs-user' &&
		(waitingActivity === undefined ? idleIsSetNext : activityPermitsRest);
	const scheduled = scheduledRestReason(
		schedules,
		name,
		now,
		humanWait
			? (item) =>
					waitingActivity === undefined
						? item.deferred?.reason === 'owner-needs-user'
						: (waitingScheduleIds?.includes(item.id) ?? false)
			: undefined,
	);
	const catchUp = await catchUpPending(name);
	const reason = catchUp
		? 'An explicit checkpoint catch-up is incomplete; resume it before confirming rest'
		: !activityPermitsRest && !idleIsSetNext
			? 'Activity is not idle'
			: cards.some((item) => item.state === 'doing')
				? 'Doing cards need attention'
				: mail
					? 'Unread mail needs attention'
					: scheduled
						? scheduled
						: addressed
							? `Room message #${addressed.id} after acknowledged cursor #${after} addresses you. Read summon --checkpoint, then pass each receipt only after reading its batch`
							: '';
	return {
		board,
		through: history.at(-1)?.id ?? 0,
		reason,
		nonce: activity?.nonce,
		// The exact activity this verdict was based on, so a caller can refuse to act on it once a
		// newer status has been written.
		activitySnapshot: activity === undefined ? undefined : JSON.stringify(activity),
		// Bind only the due schedules present at confirmation. A newly due schedule wakes the seat.
		dueScheduleIds: humanWait ? dueScheduleIds : undefined,
	};
}
