import { expect, test } from 'bun:test';

import type { MemberKeyPress, RosterRowFacts } from '../src/desktop/member-keys.ts';

import {
	MEMBER_KEYS,
	memberKeyIndex,
	pmKey,
	rowOrdinals,
	targetRowIndex,
} from '../src/desktop/member-keys.ts';

/*
 * Which key presses are the teammate shortcut (card 008508fe). Choosing the row and moving focus
 * are DOM work and are verified in the built window (summon has no DOM in bun:test); held here is
 * the rule for which presses the window takes, because every one it takes is a key no CLI
 * receives.
 */
const press = (code: string, patch: Partial<MemberKeyPress> = {}): MemberKeyPress => ({
	altKey: false,
	code,
	ctrlKey: true,
	metaKey: false,
	shiftKey: false,
	...patch,
});

test('Ctrl with a top-row digit from 1 to 9 is a sidebar position, counted from zero', () => {
	expect(MEMBER_KEYS).toBe(9);
	for (let digit = 1; digit <= MEMBER_KEYS; digit++)
		expect(memberKeyIndex(press(`Digit${String(digit)}`))).toBe(digit - 1);
});

test('there is no key for a tenth teammate', () => {
	expect(memberKeyIndex(press('Digit0'))).toBeUndefined();
});

test('any other modifier leaves the key alone', () => {
	for (const patch of [
		{ ctrlKey: false },
		{ shiftKey: true },
		{ altKey: true },
		{ metaKey: true },
		{ altKey: true, ctrlKey: true },
	] satisfies Partial<MemberKeyPress>[])
		expect(memberKeyIndex(press('Digit3', patch))).toBeUndefined();
});

test('the number pad, letters and function keys are not this shortcut', () => {
	for (const code of ['Numpad1', 'KeyJ', 'F1', 'Digit10', 'Digit', 'Backquote', 'Minus'])
		expect(memberKeyIndex(press(code))).toBeUndefined();
});

test('Ctrl+0 is the PM key (Phillip #12349), and no other press is', () => {
	expect(pmKey(press('Digit0'))).toBe(true);
	for (const patch of [
		{ ctrlKey: false },
		{ shiftKey: true },
		{ altKey: true },
		{ metaKey: true },
	] satisfies Partial<MemberKeyPress>[])
		expect(pmKey(press('Digit0', patch))).toBe(false);
	for (const code of ['Numpad0', 'Digit1', 'Digit9', 'KeyP', 'Digit00'])
		expect(pmKey(press(code))).toBe(false);
});

const row = (visible: boolean, pm = false): RosterRowFacts => ({ pm, visible });

test('Ctrl+0 selects the PM even when a filter hides its row (Phillip #12350)', () => {
	// Viewing Active while the PM rests: the PM row is hidden, two others are shown.
	const rows = [row(false, true), row(true), row(false), row(true)];
	expect(targetRowIndex(rows, press('Digit0'))).toBe(0);
	// The same PM shown is still the one selected; a later PM is never preferred.
	expect(targetRowIndex([row(true), row(true, true), row(false, true)], press('Digit0'))).toBe(1);
	expect(targetRowIndex([row(true), row(false, true), row(true, true)], press('Digit0'))).toBe(1);
	// No PM on the team: nothing.
	expect(targetRowIndex([row(true), row(false)], press('Digit0'))).toBeUndefined();
});

test('Ctrl+1 to Ctrl+9 still count only the rows the filters show', () => {
	const rows = [row(false, true), row(true), row(false), row(true)];
	expect(targetRowIndex(rows, press('Digit1'))).toBe(1);
	expect(targetRowIndex(rows, press('Digit2'))).toBe(3);
	expect(targetRowIndex(rows, press('Digit3'))).toBeUndefined();
	expect(targetRowIndex(rows, press('KeyJ'))).toBeUndefined();
});

test('the PM is ordinal 0 and the other shown rows count from 1 (Phillip #12538)', () => {
	// Wherever the PM's row sits it is 0; hidden rows use up no number.
	const rows = [row(true), row(false), row(true), row(true, true), row(true)];
	expect(rowOrdinals(rows)).toEqual([1, undefined, 2, 0, 3]);
	// Only the first PM is 0; a second counts like any teammate.
	expect(rowOrdinals([row(true, true), row(true), row(true, true)])).toEqual([0, 1, 2]);
	// A hidden PM keeps 0; the numbers stop at nine, with the keys (Phillip #15921).
	expect(rowOrdinals([row(false, true), ...Array.from({ length: 11 }, () => row(true))])).toEqual(
		[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, undefined, undefined],
	);
	// A hidden row still uses up no number, so the ninth shown row keeps 9.
	const filtered = [row(true, true), row(false), ...Array.from({ length: 10 }, () => row(true))];
	expect(rowOrdinals(filtered).slice(-2)).toEqual([9, undefined]);
	expect(rowOrdinals([])).toEqual([]);
});

test('Ctrl+1 to Ctrl+9 skip the pinned PM, so each key is the number shown (Phillip #12557)', () => {
	// The PM pinned first and shown, as in the window: Ctrl+1 is the first teammate after it.
	const rows = [row(true, true), row(true), row(false), row(true)];
	expect(targetRowIndex(rows, press('Digit0'))).toBe(0);
	expect(targetRowIndex(rows, press('Digit1'))).toBe(1);
	expect(targetRowIndex(rows, press('Digit2'))).toBe(3);
	expect(targetRowIndex(rows, press('Digit3'))).toBeUndefined();
	// Nine teammates after the PM: the ninth has Ctrl+9 again.
	const team = [row(true, true), ...Array.from({ length: 10 }, () => row(true))];
	expect(targetRowIndex(team, press('Digit9'))).toBe(9);
	// No PM: Ctrl+0 does nothing and Ctrl+1 is the first row.
	expect(targetRowIndex([row(true), row(true)], press('Digit0'))).toBeUndefined();
	expect(targetRowIndex([row(true), row(true)], press('Digit1'))).toBe(0);
});
