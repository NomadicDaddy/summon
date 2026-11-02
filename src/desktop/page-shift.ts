import type { PageExtent } from './page-extent.ts';
import type { PageState } from './page-state.ts';
import type { RuntimeFaultInput } from './types.ts';

import { describe, extentText, measureExtent } from './page-extent.ts';
import { pageStateText, px } from './page-state.ts';

/**
 * Keeps the main process told the page's layout, and puts the page itself back when it moves (C14,
 * blank-team-window-diagnosis, remediation-20261016-room-message-focus-page-shift).
 *
 * The page never scrolls by design: html and body clip (team-window-never-scrolls). A page that
 * does move leaves its columns partly or wholly out of view, which reads as a blank or cut-off
 * window (#12148, and a candidate for the 0.16.0 blank window #7088). If anything ever moves it
 * again, this scrolls root and body back to 0 (#13298) and writes one fault journal line per
 * episode: what was on screen, what made the page bigger than the window, and whether it went
 * back. The same layout goes to the main process on every change, so a renderer that later hangs,
 * fails or exits is recorded with the last layout it could report.
 */
export function pageShiftText(state: PageState, extent: PageExtent, after: PageState): string {
	const outcome =
		after.scrollX === 0 && after.scrollY === 0
			? 'It was put back in place.'
			: `It could not be put back: it is still moved by ${px(after.scrollX)}, ${px(after.scrollY)} px.`;
	return `The window's page moved out of place, so its columns may look blank or cut off: ${pageStateText(state)}; ${extentText(extent)}. ${outcome}`;
}

function currentState(): PageState {
	const page = document.scrollingElement ?? document.documentElement;
	// The page scrolls either as the root or, when the root clips, as body: either axis of either
	// one moves every column (morgan on df84bdd: body's horizontal scroll was missed).
	return {
		scrollX: page.scrollLeft || document.body.scrollLeft,
		scrollY: page.scrollTop || document.body.scrollTop,
		bodyWidth: document.body.scrollWidth,
		bodyHeight: document.body.scrollHeight,
		viewWidth: window.innerWidth,
		viewHeight: window.innerHeight,
		focused: describe(document.activeElement),
	};
}

/** Scrolls root and body back to the top left; the scroll events this fires end the episode. */
function putBack(): void {
	const page = document.scrollingElement ?? document.documentElement;
	for (const scroller of [page, document.body]) {
		scroller.scrollTop = 0;
		scroller.scrollLeft = 0;
	}
}

/**
 * Watches the page's layout: sends each change to the main process, and reports each episode of the
 * page moving once and puts the page back.
 * @param report The window's fault reporter.
 * @param send Passes the layout to the main process (fire-and-forget).
 */
export function watchPageShift(
	report: (entry: RuntimeFaultInput) => void,
	send: (state: PageState) => void,
): void {
	let reported = false;
	let sent = '';
	const check = (): void => {
		const state = currentState();
		const key = JSON.stringify(state);
		if (key !== sent) {
			sent = key;
			send(state);
		}
		const moved = state.scrollX !== 0 || state.scrollY !== 0;
		if (!moved) {
			reported = false;
			return;
		}
		// A page that will not go back stays one episode, so it is recorded once, not per event.
		if (reported) {
			putBack();
			return;
		}
		reported = true;
		// The extent is measured before the put-back moves the boxes, and the line says what the
		// put-back actually did (Roger on b79050a).
		const extent = measureExtent();
		putBack();
		report({
			level: 'warning',
			source: 'window.page-shifted',
			text: pageShiftText(state, extent, currentState()),
		});
	};
	// The page's own scroll event fires on window; body scrolling fires on body. Capture both, and
	// focus moves, which are what change the focused element the record names.
	window.addEventListener('scroll', check, { passive: true });
	document.body.addEventListener('scroll', check, { passive: true });
	window.addEventListener('resize', check, { passive: true });
	document.addEventListener('focusin', check, { passive: true });
	check();
}
