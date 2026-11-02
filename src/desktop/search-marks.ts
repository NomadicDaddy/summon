/**
 * The searched-for text, marked wherever it appears. Shared by the Diary and the Board so a hit
 * looks the same in both and one rule decides what counts as one.
 *
 * It earns its place because of the one-line change at #4578: a Diary entry is cut at the width of
 * the panel, so the word you searched for can sit past the ellipsis and the row gives no sign of
 * why it matched. Marking it answers that, and opening the row (#4633) carries the marks with it.
 * A Board card has the same problem in another shape: the hit can be in text the card keeps folded.
 *
 * Matching is case-insensitive and literal - the searches this mirrors are lowercased substring
 * tests (readDiary, matchBoardItem), so anything cleverer here would mark things they had not
 * matched.
 */
export function marked(text: string, query: string): (Node | string)[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [text];
	const parts: (Node | string)[] = [];
	const haystack = text.toLowerCase();
	let at = 0;
	for (;;) {
		const found = haystack.indexOf(needle, at);
		if (found === -1) break;
		if (found > at) parts.push(text.slice(at, found));
		const hit = document.createElement('mark');
		hit.className = 'search-hit';
		hit.textContent = text.slice(found, found + needle.length);
		parts.push(hit);
		at = found + needle.length;
	}
	if (at === 0) return [text];
	if (at < text.length) parts.push(text.slice(at));
	return parts;
}
