import { expect, test } from 'bun:test';

import { isTextPaste } from '../src/desktop/paste.ts';

test('text paste intercepts native paste chords without stealing ordinary CLI keys', () => {
	const input = {
		type: 'keyDown',
		key: 'v',
		code: 'KeyV',
		isAutoRepeat: false,
		shift: false,
		control: true,
		alt: false,
		meta: false,
	};
	expect(isTextPaste(input)).toBe(true);
	expect(isTextPaste({ ...input, shift: true })).toBe(true);
	expect(isTextPaste({ ...input, control: false, meta: true })).toBe(true);
	expect(isTextPaste({ ...input, control: false, key: 'Insert', shift: true })).toBe(true);
	expect(isTextPaste({ ...input, type: 'keyUp' })).toBe(false);
	expect(isTextPaste({ ...input, key: 'c' })).toBe(false);
	expect(isTextPaste({ ...input, control: false })).toBe(false);
	expect(isTextPaste({ ...input, alt: true })).toBe(false);
});
