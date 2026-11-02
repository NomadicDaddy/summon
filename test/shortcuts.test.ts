import { expect, test } from 'bun:test';

import { isTyping } from '../src/desktop/shortcuts.ts';

/*
 * The `?` overlay's exemption, covered here rather than in the Electron probe.
 *
 * The probe proves the toggle end to end - a real key through Chromium's input pipeline opens and
 * closes the dialog. It cannot prove this half: a probe window never takes OS focus, so calling
 * `focus()` on the composer leaves `document.activeElement` on BODY and the exemption is never
 * reached. Without these, the guard would ship exercised by nothing, and the failure it prevents is
 * a silent one - every question mark anyone typed would open a dialog instead of reaching the field.
 */

test('a keystroke in a text field belongs to the field', () => {
	expect(isTyping({ tagName: 'INPUT' })).toBe(true);
	expect(isTyping({ tagName: 'TEXTAREA' })).toBe(true);
	expect(isTyping({ tagName: 'SELECT' })).toBe(true);
});

test('a keystroke in a contenteditable belongs to the editor', () => {
	expect(isTyping({ isContentEditable: true, tagName: 'DIV' })).toBe(true);
});

test('a keystroke anywhere else belongs to the window', () => {
	expect(isTyping({ tagName: 'BODY' })).toBe(false);
	expect(isTyping({ tagName: 'DIV' })).toBe(false);
	expect(isTyping({ tagName: 'BUTTON' })).toBe(false);
	expect(isTyping({ isContentEditable: false, tagName: 'SECTION' })).toBe(false);
});

test('a target that is not an element at all is not typing', () => {
	// keydown on document or window gives a target with no tagName; it must not throw.
	expect(isTyping(null)).toBe(false);
	expect(isTyping({})).toBe(false);
});
