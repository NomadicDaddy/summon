import { expect, test } from 'bun:test';

import { keepScroll } from '../src/desktop/keep-scroll.ts';

/*
 * Phillip #19869: with enough teammates the roster scrolls, and every status update jumped it to
 * the top. The roster is rebuilt by emptying and refilling it, and with a teammate selected the
 * row is refocused mid-rebuild, which forces a layout while the roster is short, so the browser
 * clamps scrollTop. This stand-in clamps when emptied, the same effect, so the test fails if the
 * position is not read before the rebuild and written back after it. The real window is checked
 * by a probe with a focused row; without one, the window does not reproduce it.
 */
function scroller(rows: number) {
	const rowHeight = 75;
	const viewport = 400;
	let count = rows;
	let top = 0;
	const max = () => Math.max(0, count * rowHeight - viewport);
	return {
		get scrollTop() {
			return Math.min(top, max());
		},
		set scrollTop(value: number) {
			top = Math.max(0, Math.min(value, max()));
		},
		empty() {
			count = 0;
			top = Math.min(top, max());
		},
		fill(next: number) {
			count = next;
		},
	};
}

test('a rebuild that empties and refills keeps the scroll position', () => {
	const roster = scroller(12);
	roster.scrollTop = 300;
	keepScroll(roster, () => {
		roster.empty();
		roster.fill(12);
	});
	expect(roster.scrollTop).toBe(300);
});

test('control: the same rebuild without keepScroll lands at the top', () => {
	const roster = scroller(12);
	roster.scrollTop = 300;
	roster.empty();
	roster.fill(12);
	expect(roster.scrollTop).toBe(0);
});

test('a rebuild with fewer rows clamps to the new end instead of overshooting', () => {
	const roster = scroller(12);
	roster.scrollTop = 500;
	keepScroll(roster, () => {
		roster.empty();
		roster.fill(8);
	});
	expect(roster.scrollTop).toBe(8 * 75 - 400);
});
