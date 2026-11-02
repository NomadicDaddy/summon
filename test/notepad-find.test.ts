import { describe, expect, test } from 'bun:test';

import {
	findMatches,
	matchCountText,
	nearestMatch,
	stepMatch,
} from '../src/desktop/notepad-find-match.ts';

/*
 * The find bar's counting and stepping (Phillip #7628). The highlight layer and the preview
 * highlights are DOM work and are verified in the built window (shared/jimmy/notepad-find).
 */
describe('findMatches', () => {
	test('finds every occurrence, ignoring case', () => {
		expect(findMatches('Deeper deeper DEEPER', 'deeper')).toEqual([
			{ start: 0, end: 6 },
			{ start: 7, end: 13 },
			{ start: 14, end: 20 },
		]);
	});

	test('treats the query literally', () => {
		expect(findMatches('a.b axb (x)', 'a.b')).toEqual([{ start: 0, end: 3 }]);
		expect(findMatches('call(x) call', '(x)')).toEqual([{ start: 4, end: 7 }]);
	});

	test('does not overlap matches', () => {
		expect(findMatches('aaaa', 'aa')).toEqual([
			{ start: 0, end: 2 },
			{ start: 2, end: 4 },
		]);
	});

	test('an empty query finds nothing rather than everything', () => {
		expect(findMatches('anything', '')).toEqual([]);
	});

	test('offsets index the original text even where lowercasing would change its length', () => {
		// "İ" lowercases to two code units; the offsets must still point into the original.
		const text = 'İstanbul and istanbul';
		const matches = findMatches(text, 'stanbul');
		expect(matches.map((match) => text.slice(match.start, match.end))).toEqual([
			'stanbul',
			'stanbul',
		]);
	});

	test('finds across lines', () => {
		expect(findMatches('one\ntwo\none', 'one')).toEqual([
			{ start: 0, end: 3 },
			{ start: 8, end: 11 },
		]);
	});
});

describe('stepping', () => {
	const three = [
		{ start: 0, end: 1 },
		{ start: 10, end: 11 },
		{ start: 20, end: 21 },
	];

	test('a fresh search lands on the first match at or after the caret, wrapping', () => {
		expect(nearestMatch(three, 0)).toBe(0);
		expect(nearestMatch(three, 5)).toBe(1);
		expect(nearestMatch(three, 10)).toBe(1);
		expect(nearestMatch(three, 25)).toBe(0);
		expect(nearestMatch([], 0)).toBe(-1);
	});

	test('next and previous wrap at both ends', () => {
		expect(stepMatch(3, 2, 1)).toBe(0);
		expect(stepMatch(3, 0, -1)).toBe(2);
		expect(stepMatch(3, 1, 1)).toBe(2);
		expect(stepMatch(0, -1, 1)).toBe(-1);
		expect(stepMatch(3, -1, -1)).toBe(2);
	});

	test('the count reads "n of m", "No matches", or nothing before typing', () => {
		expect(matchCountText(12, 2, 'x')).toBe('3 of 12');
		expect(matchCountText(0, -1, 'x')).toBe('No matches');
		expect(matchCountText(0, -1, '')).toBe('');
	});
});
