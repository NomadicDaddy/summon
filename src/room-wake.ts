import { addressableText } from './room-address.ts';
import { groupRecipients, type RoomGroups } from './room-groups.ts';

interface WakeEvent {
	sender: { kind: string; id: string };
	text: string;
	replyTo: number | null;
	groups?: RoomGroups;
}

const ALL_MENTION = /(?<![\p{L}\p{N}_@])@all(?![\p{L}\p{N}_])/iu;

function mentionedSlugs(text: string, slugs: readonly string[], broadcast = true): string[] {
	if (broadcast && ALL_MENTION.test(text)) return [...slugs];
	return slugs.filter((slug) => {
		const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		return new RegExp(`(?<![\\p{L}\\p{N}_@])@${escaped}(?![\\p{L}\\p{N}_-])`, 'iu').test(text);
	});
}

/**
 * The members an event names explicitly. A group token the event resolved when it was sent
 * (a key in its stored groups) is that group, never also a member registered under the same
 * spelling; that member is reached only if the stored list selected it. Events stored without
 * groups keep the plain name meaning. With `broadcast` false, @all names nobody.
 */
export function explicitNames(
	event: Pick<WakeEvent, 'text' | 'groups'>,
	slugs: readonly string[],
	broadcast = true,
): string[] {
	const groupTokens = Object.keys(event.groups ?? {});
	if (!groupTokens.length) return mentionedSlugs(event.text, slugs, broadcast);
	// Checked before the filter so @all still reaches a member named like a group token.
	if (broadcast && ALL_MENTION.test(event.text)) return [...slugs];
	return mentionedSlugs(
		event.text,
		slugs.filter((slug) => !groupTokens.includes(slug)),
		broadcast,
	);
}

/**
 * The members an event may start. An agent's @all notifies every running member (addressedTo)
 * but starts and resumes nobody (Phillip #21677); a human or CLI @all starts everyone, and an
 * agent naming one member can still start that member. Quoted examples and code are not
 * mentions (addressableText), the same reading addressedTo uses, so a quoted @name or @all starts
 * nobody on any start path (Roger M1 and Morticia I1 on 9b871ec).
 */
export function startableNames(
	event: Pick<WakeEvent, 'sender' | 'text' | 'groups'>,
	slugs: readonly string[],
): string[] {
	return explicitNames(
		{ ...event, text: addressableText(event.text) },
		slugs,
		event.sender.kind !== 'agent',
	);
}

export function directlyAddressed(text: string, name: string): boolean {
	return mentionedSlugs(addressableText(text), [name]).length > 0;
}

/** Named in the text, or selected by an @online/@offline group resolved when it was sent. */
export function addressedTo(event: Pick<WakeEvent, 'text' | 'groups'>, name: string): boolean {
	return (
		explicitNames({ ...event, text: addressableText(event.text) }, [name]).length > 0 ||
		groupRecipients(event.groups).includes(name)
	);
}

/**
 * Whether the event may start `name` while its session is stopped, as a rest resume does: named
 * explicitly (startableNames), or in the offline group of a human or CLI post, the same rule as
 * groupWakeTargets. An agent's group or @all post still ends a running member's rest through
 * addressedTo.
 */
export function addressedToStopped(
	event: Pick<WakeEvent, 'sender' | 'text' | 'groups'>,
	name: string,
): boolean {
	return (
		startableNames(event, [name]).length > 0 ||
		(event.sender.kind !== 'agent' && (event.groups?.offline ?? []).includes(name))
	);
}

/**
 * A burst is delivered once it has stopped, not once per message in it.
 *
 * The window is a DEBOUNCE measured from the last message, which is not what it used to be: it was
 * a throttle measured from the FIRST unread one, so it fired in the middle of a burst and then
 * again for the tail. Worse, addressed and human traffic bypassed it outright, so an active room
 * with the operator in it produced one notice per turn step. Since every notice carries the same
 * text - go and checkpoint - N of them tell a session exactly what one does, and the one that
 * arrives after the room settles is the one worth interrupting for.
 */
export const ROOM_WAKE_QUIET_MS = 30_000;
/**
 * A room that never falls quiet would starve a pure debounce, so the wake goes out regardless.
 *
 * This ceiling wants to sit well above the quiet window, or it stops being a starvation guard and
 * starts being the ordinary delivery path. Both were 30_000. Replaying a real 13-message room
 * burst against these functions, that produced 21 deliveries of which 7 fired on the ceiling
 * mid-burst - precisely the "fires in the middle of a burst and then again for the tail" behaviour
 * the debounce above was introduced to end. At 120_000 the same burst delivers 17 times, every one
 * of them decided by quiet, and the ceiling returns to covering only a room that genuinely will
 * not stop.
 *
 * It was NOT dead at 30_000 - quiet still decided 14 of the 21 - because a delivery clears the
 * batch and restarts `firstAt`, so the ceiling only wins inside a sustained run. Raising it
 * removes that remaining case rather than switching the debounce on.
 */
export const ROOM_WAKE_MAX_HOLD_MS = 120_000;

export interface RoomWakeBatch {
	firstAt: number;
	lastChangeAt: number;
	through: number;
}

/**
 * Records this tick's watermark and restarts the quiet window whenever it moved. The watermark is
 * what a poller can actually observe, so the debounce needs no per-event arrival times.
 */
export function trackRoomWakeBatch(
	batches: Map<string, RoomWakeBatch>,
	path: string,
	through: number,
	now = Date.now(),
): RoomWakeBatch {
	const existing = batches.get(path);
	if (!existing) {
		const started = { firstAt: now, lastChangeAt: now, through };
		batches.set(path, started);
		return started;
	}
	if (existing.through !== through) {
		existing.lastChangeAt = now;
		existing.through = through;
	}
	return existing;
}

export interface RoomWakeWindows {
	quiet: number;
	maxHold: number;
}

function envMs(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * The suite collapses the quiet window to zero so a delivery test does not spend thirty seconds
 * waiting one out. The timing itself is covered by cases that pass their windows explicitly, which
 * is the only place it can be asserted without making the clock part of the test.
 */
function roomWakeWindows(): RoomWakeWindows {
	return {
		quiet: envMs('SUMMON_ROOM_WAKE_QUIET_MS', ROOM_WAKE_QUIET_MS),
		maxHold: envMs('SUMMON_ROOM_WAKE_MAX_HOLD_MS', ROOM_WAKE_MAX_HOLD_MS),
	};
}

export function roomWakeDue(
	batch: RoomWakeBatch,
	now = Date.now(),
	windows = roomWakeWindows(),
): boolean {
	return now - batch.lastChangeAt >= windows.quiet || now - batch.firstAt >= windows.maxHold;
}

/** The next exact quiet or starvation deadline for a batch already observed. */
export function roomWakeDeadline(batch: RoomWakeBatch, windows = roomWakeWindows()): number {
	return Math.min(batch.lastChangeAt + windows.quiet, batch.firstAt + windows.maxHold);
}

/**
 * Whether newly arrived traffic justifies re-notifying a session that was already told and has not
 * acknowledged yet. This no longer skips the delay - nothing does - it only decides whether a stale
 * wake is refreshed rather than left sitting behind an older unacknowledged cursor.
 */
export function roomWakeImmediate(name: string, events: WakeEvent[], ownIds: Set<number>): boolean {
	return roomWakeCauses(name, events, ownIds).length > 0;
}

/**
 * The events that address this member: human and CLI posts, replies to its posts, mentions, and
 * @online or @offline groups that resolved to it when the message was sent.
 */
export function roomWakeCauses<T extends WakeEvent>(
	name: string,
	events: readonly T[],
	ownIds: Set<number>,
): T[] {
	return events.filter(
		(event) =>
			event.sender.kind === 'user' ||
			event.sender.kind === 'cli' ||
			(event.replyTo !== null && ownIds.has(event.replyTo)) ||
			addressedTo(event, name),
	);
}

export const WAKE_CAUSE_LIMIT = 5;

/**
 * The most a wake notice's cause header plus CHECKPOINT_NOTICE_INSTRUCTION may take, in ASCII
 * characters. It replaced the old 120-character bound when notices began naming their causes: room
 * for five ids, the overflow pointer and the cursor, each at Number.MAX_SAFE_INTEGER width.
 */
export const WAKE_NOTICE_MAX = 384;

/**
 * The notice's opening: the read cursor labelled as a cursor, then the exact items that caused the
 * wake and one read-only command template to open each. Later traffic only moves the cursor; it never
 * becomes a cause. Telegram's read takes a cursor and shows what follows it, so a sequence is opened
 * from the cursor just before it, and the template says so rather than printing the sequence as one.
 */
export function wakeCauseText(
	source: 'room' | 'Telegram',
	through: number,
	causes: readonly number[],
): string {
	const head = `summon ${source} through ${through} (read cursor)`;
	if (causes.length === 0) return `${head}; nothing in it addresses you.`;
	const shown = causes.slice(0, WAKE_CAUSE_LIMIT);
	const more = causes.length - shown.length;
	const items =
		source === 'room' ? shown.map((id) => `#${id}`).join(' ') : `seq ${shown.join(' ')}`;
	const open = source === 'room' ? 'summon --room show <id>' : 'summon --telegram read <seq-1>';
	return (
		`${head}; for you: ${items}` +
		(more > 0 ? ` +${more} more in summon --checkpoint manifest` : '') +
		` (${open}).`
	);
}
