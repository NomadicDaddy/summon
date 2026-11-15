// Moves the Room read marker as the operator reads (Phillip #46659, amended #51167 on #51137).
//
// A post counts as seen once it has been wholly inside the message area for one second while the
// Room is open and the Window is focused and visible. The marker then advances through loaded posts
// in order, but only as far as an unbroken run of seen posts reaches: a post skipped by a fast
// scroll stops it. Reaching the bottom of the live Room under the same conditions for one second is
// the exception the amendment chose: it marks everything through the last post read, because a
// single marker cannot both skip unseen posts and clear the badge at the end. The marker only ever
// moves forward here; the explicit "Mark read" buttons keep their own behaviour.

import { fullyVisibleMessages } from './room-read-place.ts';

const DWELL_MS = 1000;
const TICK_MS = 250;

export interface AutoReadPlace {
	readThrough: () => number | null;
	/** The Room's first unread post, as the Room reports it; null when unknown or none. */
	firstUnread: () => number | null;
	advance: (id: number) => Promise<void>;
}

/** Room message ids in display order, oldest first. */
function loadedIds(messages: HTMLElement): number[] {
	return [...messages.querySelectorAll<HTMLElement>('article.room-message[data-room-id]')]
		.map((item) => Number(item.dataset.roomId))
		.filter((id) => Number.isSafeInteger(id) && id > 0);
}

/** The operator can be reading the Room: it is open, and the Window is focused and visible. */
function attending(messages: HTMLElement): boolean {
	return (
		document.visibilityState === 'visible' &&
		document.hasFocus() &&
		messages.getClientRects().length > 0
	);
}

export function setupRoomAutoRead(
	messages: HTMLElement,
	place: AutoReadPlace,
	isBrowsing: () => boolean,
	now: () => number = Date.now,
): () => void {
	const visibleSince = new Map<number, number>();
	const seen = new Set<number>();
	let bottomSince: number | null = null;
	let advancing = false;

	const target = (at: number): number | null => {
		const ids = loadedIds(messages);
		if (ids.length === 0) return null;
		const atBottom =
			!isBrowsing() &&
			messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 2;
		if (!atBottom) bottomSince = null;
		else if (bottomSince === null) bottomSince = at;
		else if (at - bottomSince >= DWELL_MS) return ids.at(-1) ?? null;
		// Walk the unbroken run of seen posts from the Room's first unread one. Away from the live
		// bottom the walk needs that known start: with no marker yet, or with the first unread post
		// not loaded as a message of its own, older posts outside the window were never on screen,
		// so only the bottom-of-Room rule above (or an explicit Mark read) can move the marker
		// (Roger #51267).
		if (place.readThrough() === null) return null;
		const first = place.firstUnread();
		const start = first === null ? -1 : ids.indexOf(first);
		if (start < 0) return null;
		let reached: number | null = null;
		for (let index = start; index < ids.length; index++) {
			const id = ids[index];
			if (id === undefined || !seen.has(id)) break;
			reached = id;
		}
		return reached;
	};

	const tick = (): void => {
		if (!attending(messages)) {
			visibleSince.clear();
			bottomSince = null;
			return;
		}
		const at = now();
		const visible = new Set(fullyVisibleMessages(messages));
		for (const id of visibleSince.keys()) if (!visible.has(id)) visibleSince.delete(id);
		for (const id of visible) {
			const since = visibleSince.get(id);
			if (since === undefined) visibleSince.set(id, at);
			else if (at - since >= DWELL_MS) seen.add(id);
		}
		const next = target(at);
		const readThrough = place.readThrough();
		if (next === null || advancing || (readThrough !== null && next <= readThrough)) return;
		advancing = true;
		void place.advance(next).finally(() => {
			advancing = false;
		});
	};

	const timer = setInterval(tick, TICK_MS);
	return () => {
		clearInterval(timer);
	};
}
