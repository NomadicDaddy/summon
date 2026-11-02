import { expect, test } from 'bun:test';

import { placeCaret, rememberCaret, textHash } from '../src/desktop/notepad-caret.ts';

/*
 * Caret placement on load (#7047): the place Phillip left off when the text is unchanged, the top
 * when the text is different. The wrong answers: the end of the text (what assigning a value does),
 * a remembered place applied to a text it was not recorded against, or a place past the end.
 */
function store() {
	let value: string | null = null;
	return {
		read: () => value,
		write: (next: string) => {
			value = next;
		},
	};
}

test('nothing remembered means the top', () => {
	expect(placeCaret(store(), 'one\ntwo')).toEqual({ end: 0, scrollTop: 0, start: 0 });
});

test('the remembered place returns for the exact text it was recorded against', () => {
	const s = store();
	rememberCaret(s, 'one\ntwo\nthree', 5, 7, 120);
	expect(placeCaret(s, 'one\ntwo\nthree')).toEqual({ end: 7, scrollTop: 120, start: 5 });
});

test('a text that changed, even by one character, starts at the top', () => {
	const s = store();
	rememberCaret(s, 'one\ntwo\nthree', 5, 5, 120);
	expect(placeCaret(s, 'one\ntwo\nthree!')).toEqual({ end: 0, scrollTop: 0, start: 0 });
	expect(placeCaret(s, 'one\ntwo\nthre')).toEqual({ end: 0, scrollTop: 0, start: 0 });
	expect(textHash('a')).not.toBe(textHash('b'));
});

test('a damaged memory is ignored rather than trusted', () => {
	const s = store();
	s.write('{');
	expect(placeCaret(s, 'x')).toEqual({ end: 0, scrollTop: 0, start: 0 });
	s.write(JSON.stringify({ hash: textHash('x'), start: 'no' }));
	expect(placeCaret(s, 'x')).toEqual({ end: 0, scrollTop: 0, start: 0 });
});

test('a remembered place past the end is clamped, never thrown', () => {
	const s = store();
	s.write(JSON.stringify({ end: 99, hash: textHash('short'), scrollTop: -5, start: 99 }));
	expect(placeCaret(s, 'short')).toEqual({ end: 5, scrollTop: 0, start: 5 });
});
