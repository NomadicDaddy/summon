import type { LocalEvent } from './local-room.ts';

import { cachedLocalEvents, localHead } from './local-room.ts';
import { isRoomReaction } from './room-reaction-kind.ts';

export interface RoomUnreadStats {
	firstUnread: number | null;
	unread: number;
	known: boolean;
}

export function unreadStats(
	events: readonly LocalEvent[],
	readThrough: number,
	head: number,
): RoomUnreadStats {
	if (!Number.isSafeInteger(readThrough) || readThrough < 0 || readThrough > head)
		return { firstUnread: null, unread: 0, known: false };
	const first = events[0];
	if ((first && readThrough < first.id - 1) || (!first && head > readThrough))
		return { firstUnread: null, unread: 0, known: false };
	const posts = events.filter((event) => event.id > readThrough && !isRoomReaction(event));
	return { firstUnread: posts[0]?.id ?? null, unread: posts.length, known: true };
}

export async function localUnreadStats(readThrough: number): Promise<RoomUnreadStats> {
	const events = await cachedLocalEvents();
	return unreadStats(events, readThrough, events.at(-1)?.id ?? (await localHead()));
}

export interface RoomBeforePage {
	events: LocalEvent[];
	nextBefore: number;
	more: boolean;
}

/** One older page, returned in chronological order for transcript prepending. */
export function beforePage(events: readonly LocalEvent[], before: number): RoomBeforePage {
	if (!Number.isSafeInteger(before) || before < 1)
		throw new Error('Invalid Room history position.');
	const prior = events.filter((event) => event.id < before);
	const page = prior.slice(-20);
	return {
		events: page,
		nextBefore: page[0]?.id ?? before,
		more: prior.length > page.length,
	};
}

export async function localBeforePage(before: number): Promise<RoomBeforePage> {
	return beforePage(await cachedLocalEvents(), before);
}
