import type { LocalEvent } from '../local-room.ts';

import { readableError } from './ipc-error.ts';

/** A bounded transcript view around an older read or leave marker. */
export function setupRoomHistory(
	messages: HTMLElement,
	get: (id: string) => HTMLElement,
	append: (event: LocalEvent, before?: Element | null) => void,
	redraw: () => void,
	head: () => number,
	busy: () => boolean,
	showLatest: () => void,
	report: (message: string) => void,
): { isBrowsing: () => boolean; updateHead: () => void } {
	const older = get('room-load-older') as HTMLButtonElement;
	const newer = get('room-load-newer') as HTMLButtonElement;
	const latest = get('room-show-latest') as HTMLButtonElement;
	let browsing = false;
	let loading = false;
	let oldest = 0;
	let last = 0;
	let moreOlder = false;
	let moreNewer = false;
	const renderedIds = (): number[] =>
		[...messages.querySelectorAll<HTMLElement>('article.room-message[data-room-id]')]
			.map((item) => Number(item.dataset.roomId))
			.filter((id) => Number.isSafeInteger(id) && id > 0);
	const buttons = (): void => {
		older.hidden = newer.hidden = latest.hidden = !browsing;
		older.disabled = loading || !moreOlder;
		newer.disabled = loading || (!moreNewer && last >= head());
		latest.disabled = loading || busy();
	};
	messages.addEventListener('room-place-jump', (event) => {
		const id = (event as CustomEvent<unknown>).detail;
		if (
			typeof id !== 'number' ||
			!Number.isSafeInteger(id) ||
			id < 1 ||
			id === Number.MAX_SAFE_INTEGER ||
			loading ||
			busy()
		)
			return;
		loading = true;
		buttons();
		void window.team
			.roomBefore(id + 1)
			.then((page) => {
				if (!page.events.some((item) => item.id === id))
					throw new Error(`Message #${id} is not in readable Room history.`);
				browsing = true;
				messages.replaceChildren();
				for (const item of page.events) append(item);
				oldest = page.nextBefore;
				last = page.events.at(-1)?.id ?? id;
				moreOlder = page.more;
				moreNewer = last < head();
				redraw();
				const target = document.getElementById(`room-message-${id}`);
				target?.scrollIntoView({ block: 'center' });
				if (target instanceof HTMLElement) {
					target.tabIndex = -1;
					target.focus({ preventScroll: true });
				}
			})
			.catch((cause: unknown) => {
				report(`Room place unavailable: ${readableError(cause)}`);
			})
			.finally(() => {
				loading = false;
				buttons();
			});
	});
	older.addEventListener('click', () => {
		if (!browsing || !moreOlder || loading) return;
		loading = true;
		buttons();
		void window.team
			.roomBefore(oldest)
			.then((page) => {
				if (page.events.length === 0 || page.nextBefore >= oldest)
					throw new Error('Older Room history made no progress.');
				const anchor = messages.firstElementChild;
				const height = messages.scrollHeight;
				for (const item of page.events) append(item, anchor);
				oldest = page.nextBefore;
				moreOlder = page.more;
				const renderedLast = renderedIds().at(-1);
				if (renderedLast !== undefined && renderedLast < last) {
					last = renderedLast;
					moreNewer = true;
				}
				messages.scrollTop += messages.scrollHeight - height;
				redraw();
			})
			.catch((cause: unknown) => {
				report(`Older Room page unavailable: ${readableError(cause)}`);
			})
			.finally(() => {
				loading = false;
				buttons();
			});
	});
	const caughtUp = (): boolean => !moreNewer && last >= head();
	const atBottom = (): boolean =>
		messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 2;
	// Back to the live Room without clearing the page: everything up to the head is already drawn,
	// so new posts append and follow as usual. Never while a refresh is in flight, because that
	// refresh has advanced the head over posts it skipped drawing while browsing.
	const rejoin = (): void => {
		if (!browsing || loading || busy() || !caughtUp()) return;
		browsing = false;
		buttons();
		redraw();
	};
	const loadNewer = (): void => {
		if (!browsing || loading || caughtUp()) return;
		loading = true;
		buttons();
		void window.team
			.roomRead(last)
			.then((page) => {
				if (page.events.length === 0 || page.nextCursor <= last)
					throw new Error('Newer Room history made no progress.');
				for (const item of page.events) append(item);
				last = page.nextCursor;
				moreNewer = page.more;
				const renderedFirst = renderedIds()[0];
				if (renderedFirst !== undefined && renderedFirst > oldest) {
					oldest = renderedFirst;
					moreOlder = true;
				}
				redraw();
			})
			.catch((cause: unknown) => {
				report(`Newer Room page unavailable: ${readableError(cause)}`);
			})
			.finally(() => {
				loading = false;
				buttons();
			});
	};
	newer.addEventListener('click', loadNewer);
	// A reader who scrolls to the bottom of a history page is asking for what comes next. Before
	// this, the page simply ended there and only the Newer button moved on (Phillip #44950).
	messages.addEventListener('scroll', () => {
		if (!browsing || loading || busy() || !atBottom()) return;
		if (caughtUp()) rejoin();
		else loadNewer();
	});
	const leaveHistory = (): void => {
		if (loading || busy()) return;
		browsing = false;
		messages.replaceChildren();
		buttons();
		showLatest();
	};
	latest.addEventListener('click', leaveHistory);
	// Called after each refresh has settled. A reader already at the bottom of a caught-up page
	// rejoins here, since no scroll event will come to do it.
	const updateHead = (): void => {
		buttons();
		if (browsing && atBottom()) rejoin();
	};
	return { isBrowsing: () => browsing, updateHead };
}
