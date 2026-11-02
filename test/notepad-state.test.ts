import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { NotepadState, parseNotepadDraft } from '../src/desktop/notepad-state.ts';

const disk = (text: string) => ({
	text,
	revision: createHash('sha256').update(text).digest('hex'),
});

test('a clean reopen adopts an outside edit while a same-base local edit survives', () => {
	const state = new NotepadState();
	state.reconcile(disk('original'));
	state.reconcile(disk('outside edit'));
	expect(state.text).toBe('outside edit');
	expect(state.base).toEqual(disk('outside edit'));
	state.text = 'unsaved draft';
	state.reconcile(disk('outside edit'));
	expect(state.text).toBe('unsaved draft');
	expect(state.conflict).toBeUndefined();
});

test('outside changes retain both versions until Keep and detect another change before save', () => {
	const state = new NotepadState();
	state.reconcile(disk('original'));
	state.text = 'my draft';
	state.reconcile(disk('first outside edit'));
	expect(state.text).toBe('my draft');
	expect(state.base).toEqual(disk('original'));
	expect(state.conflict).toEqual(disk('first outside edit'));
	state.keepDraft();
	expect(state.text).toBe('my draft');
	expect(state.base).toEqual(disk('first outside edit'));
	expect(state.conflict).toBeUndefined();
	state.reconcile(disk('second outside edit'));
	expect(state.text).toBe('my draft');
	expect(state.conflict).toEqual(disk('second outside edit'));
});

test('recovered draft checks its actual revision before it can overwrite a newer disk version', () => {
	const raw = JSON.stringify({ text: 'recovered draft', revision: disk('original').revision });
	const state = new NotepadState();
	state.reconcile(disk('new disk'), parseNotepadDraft(raw));
	expect(state.text).toBe('recovered draft');
	expect(state.conflict).toEqual(disk('new disk'));
	state.useDisk(disk('newest disk'));
	expect(state.text).toBe('newest disk');
	expect(state.base).toEqual(disk('newest disk'));
	expect(state.conflict).toBeUndefined();
});

test('a draft matching disk resolves without a write; malformed recovery remains an explicit error', () => {
	const state = new NotepadState();
	state.reconcile(disk('old'));
	state.text = 'same final text';
	state.reconcile(disk('same final text'));
	expect(state.conflict).toBeUndefined();
	expect(state.base).toEqual(disk('same final text'));
	for (const raw of ['{', '[]', '{"text":"draft","revision":"invalid"}']) {
		expect(() => parseNotepadDraft(raw)).toThrow();
	}
	expect(parseNotepadDraft(null)).toBeUndefined();
	expect(() => new NotepadState().keepDraft()).toThrow('No notepad conflict');
});
