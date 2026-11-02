/** One occurrence of the search text, as UTF-16 offsets into the searched string. */
export interface FindMatch {
	start: number;
	end: number;
}

/**
 * Every non-overlapping occurrence of `query` in `text`, ignoring case, as the notepad's find bar
 * counts them (Phillip #7628: find and highlight only, no replace). The query is literal: `.` or
 * `(` match themselves. Case folding goes through a Unicode-aware regular expression rather than
 * lowercasing both strings, because lowercasing can change a string's length and the offsets
 * must index the original text.
 */
export function findMatches(text: string, query: string): FindMatch[] {
	if (query === '') return [];
	const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
	return [...text.matchAll(pattern)].map((found) => ({
		start: found.index,
		end: found.index + found[0].length,
	}));
}

/**
 * Which match a fresh search lands on: the first one at or after `from` (the caret, or where the
 * previous current match began), wrapping to the first match; -1 when there are none.
 */
export function nearestMatch(matches: FindMatch[], from: number): number {
	if (matches.length === 0) return -1;
	const index = matches.findIndex((match) => match.start >= from);
	return index === -1 ? 0 : index;
}

/** The match after or before `current`, wrapping at either end; -1 when there are none. */
export function stepMatch(count: number, current: number, direction: 1 | -1): number {
	if (count === 0) return -1;
	if (current < 0) return direction === 1 ? 0 : count - 1;
	return (current + direction + count) % count;
}

/** The count the bar shows: "3 of 12", or "No matches" once something has been typed. */
export function matchCountText(count: number, current: number, query: string): string {
	if (query === '') return '';
	return count === 0 ? 'No matches' : `${current + 1} of ${count}`;
}
