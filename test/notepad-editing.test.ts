import { expect, test } from 'bun:test';

import { deleteEmptyLine, moveLines } from '../src/desktop/notepad-editing.ts';

/*
 * Phillip's three notepad editing habits (#7025, #7026 is wrap and lives in the DOM, #7028).
 * Each rule has an obvious wrong answer: deleting a line that has text on it, moving a line off
 * either end, or losing the selection after a move.
 */
const caret = (offset: number) => ({ end: offset, start: offset });

test('Ctrl+X on an empty line removes the line and its break', () => {
	expect(deleteEmptyLine('one\n\nthree', caret(4))).toEqual({
		end: 4,
		start: 4,
		value: 'one\nthree',
	});
	// The first line, empty: the following line moves up to the top.
	expect(deleteEmptyLine('\ntwo', caret(0))).toEqual({ end: 0, start: 0, value: 'two' });
});

test('Ctrl+X on an empty last line removes the break before it', () => {
	expect(deleteEmptyLine('one\ntwo\n', caret(8))).toEqual({
		end: 7,
		start: 7,
		value: 'one\ntwo',
	});
	// A lone empty document has nothing to delete.
	expect(deleteEmptyLine('', caret(0))).toBeUndefined();
});

test('Ctrl+X keeps its default on a line with text or with a selection', () => {
	expect(deleteEmptyLine('one\ntwo', caret(5))).toBeUndefined();
	expect(deleteEmptyLine('one\n\nthree', { end: 4, start: 1 })).toBeUndefined();
	// Whitespace is text: a line of spaces is not empty.
	expect(deleteEmptyLine('one\n  \nthree', caret(5))).toBeUndefined();
});

test('Alt+Up and Alt+Down move the caret line and carry the caret with it', () => {
	expect(moveLines('a\nb\nc', caret(2), 'up')).toEqual({ end: 0, start: 0, value: 'b\na\nc' });
	expect(moveLines('a\nb\nc', caret(2), 'down')).toEqual({ end: 4, start: 4, value: 'a\nc\nb' });
	// Mid-line caret keeps its column.
	expect(moveLines('one\ntwo\nthree', caret(5), 'down')).toEqual({
		end: 11,
		start: 11,
		value: 'one\nthree\ntwo',
	});
});

test('a selection spanning two lines moves as a block', () => {
	// "b" and "c" selected (offsets 2..5) move above "a".
	expect(moveLines('a\nb\nc\nd', { end: 5, start: 2 }, 'up')).toEqual({
		end: 3,
		start: 0,
		value: 'b\nc\na\nd',
	});
	// A selection ending at the start of a line does not drag that line along.
	expect(moveLines('a\nb\nc\nd', { end: 4, start: 2 }, 'down')).toEqual({
		end: 6,
		start: 4,
		value: 'a\nc\nb\nd',
	});
});

test('nothing moves past the top or the bottom', () => {
	expect(moveLines('a\nb', caret(0), 'up')).toBeUndefined();
	expect(moveLines('a\nb', caret(3), 'down')).toBeUndefined();
	expect(moveLines('only', caret(2), 'up')).toBeUndefined();
});
