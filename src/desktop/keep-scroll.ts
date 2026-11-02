/**
 * Rebuild an element's contents without moving its scroll position (Phillip #19869). The roster is
 * its own scroll container and is emptied and refilled on every snapshot. With a teammate selected,
 * the rebuild refocuses that row as soon as it is appended, and focus() forces a layout while only
 * the first rows exist, so the browser clamped scrollTop to that short height and every status
 * update jumped a long roster to the top. Read the position first and restore it once the rows,
 * and anything that hides some of them, are back.
 */
export function keepScroll(element: { scrollTop: number }, rebuild: () => void): void {
	const top = element.scrollTop;
	rebuild();
	element.scrollTop = top;
}
