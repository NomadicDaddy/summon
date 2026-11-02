import { expect, test } from 'bun:test';

import type { PageState } from '../src/desktop/page-state.ts';
import type { RuntimeFaultInput } from '../src/runtime-fault-model.ts';

import { pageShiftText } from '../src/desktop/page-shift.ts';
import { lastPageText, pageStateFrom } from '../src/desktop/page-state.ts';
import { watchWindowHealth } from '../src/desktop/window-health.ts';
import { runtimeFaultText } from '../src/runtime-fault-model.ts';

/*
 * C14 (blank-team-window-diagnosis): the 0.16.0 blank window (#7088) left no fault because only a
 * renderer exit was recorded. These hold which renderer events now leave a journal line, that each
 * line carries the page's last-known layout (Roger on df84bdd), and that none of them reloads or
 * restarts anything beyond the existing exit handling.
 */
type Listener = (...args: never[]) => void;
function fakeContents() {
	const listeners = new Map<string, Listener>();
	return {
		on: (event: string, listener: Listener) => {
			listeners.set(event, listener);
			return undefined;
		},
		emit: (event: string, ...args: unknown[]) => {
			(listeners.get(event) as ((...values: unknown[]) => void) | undefined)?.(...args);
		},
	};
}

const LAST =
	'Last page state, 4 s old: page moved by 0, 0 px; page 2251x1310, window 2251x1310; focus on body.';

function setup() {
	const contents = fakeContents();
	const lines: RuntimeFaultInput[] = [];
	let gone = 0;
	let clock = 1_000;
	watchWindowHealth(
		contents,
		(input) => {
			lines.push(input);
			return Promise.resolve();
		},
		() => {
			gone++;
		},
		() => LAST,
		() => clock,
	);
	return {
		contents,
		lines,
		gone: () => gone,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

test('a renderer exit is recorded with the last page state and ends the window, as before', () => {
	const s = setup();
	s.contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 3 });
	expect(s.lines).toEqual([
		{
			level: 'error',
			source: 'window.renderer-exit',
			text: `Renderer ended: crashed; exit code 3. ${LAST}`,
		},
	]);
	expect(s.gone()).toBe(1);
});

test('a hang is recorded once with the last page state, and its end with how long it lasted', () => {
	const s = setup();
	s.contents.emit('unresponsive');
	s.contents.emit('unresponsive');
	s.advance(12_340);
	s.contents.emit('responsive');
	s.contents.emit('responsive');
	expect(s.lines.map((line) => line.source)).toEqual([
		'window.renderer-unresponsive',
		'window.renderer-responsive',
	]);
	expect(s.lines[0]?.text.endsWith(LAST)).toBe(true);
	expect(s.lines[1]?.text).toBe('The Team Window is responding again after 12.3 s.');
	expect(s.lines.every((line) => line.level === 'warning')).toBe(true);
	expect(s.gone()).toBe(0);
});

test('a failed page load is recorded with the last page state; a sub-frame failing is not', () => {
	const s = setup();
	s.contents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x/index.html', true);
	s.contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///x/preview.html', false);
	expect(s.lines).toEqual([
		{
			level: 'error',
			source: 'window.load-failed',
			text: `The Team Window page did not load: ERR_FILE_NOT_FOUND (-6). ${LAST}`,
		},
	]);
	expect(s.gone()).toBe(0);
});

test('a preload failure is recorded with the last page state', () => {
	const s = setup();
	s.contents.emit('preload-error', {}, 'preload.cjs', new Error('bridge exploded'));
	expect(s.lines).toEqual([
		{
			level: 'error',
			source: 'window.preload-failed',
			text: `The Team Window bridge did not load: bridge exploded ${LAST}`,
		},
	]);
});

test('the last page state survives the journal after a multi-line or very long outside text', () => {
	// The journal keeps the first line and 2048 characters (runtimeFaultText; morgan on 5ab7dd8).
	const s = setup();
	s.contents.emit('preload-error', {}, 'preload.cjs', new Error('first line\nsecond line'));
	s.contents.emit('preload-error', {}, 'preload.cjs', new Error('x'.repeat(5000)));
	s.contents.emit('did-fail-load', {}, -2, 'bad\r\ndescription', 'file:///x', true);
	s.contents.emit(
		'render-process-gone',
		{},
		{ reason: `crashed\n${'y'.repeat(3000)}`, exitCode: 1 },
	);
	// Roger on c19fac8: the formatter's whole-text and to-end-of-line redactions.
	s.contents.emit(
		'preload-error',
		{},
		'preload.cjs',
		new Error('bridge payload is not valid JSON at position 4'),
	);
	s.contents.emit(
		'preload-error',
		{},
		'preload.cjs',
		new Error('fetch failed Authorization: Bearer abc.def.ghi more'),
	);
	expect(s.lines).toHaveLength(6);
	const kept = s.lines.map((line) => runtimeFaultText(line.text));
	for (const text of kept) expect(text.endsWith(LAST)).toBe(true);
	// Morgan on c19fac8: only the first line of an outside text is kept, as for any record.
	expect(kept[0]).toContain('did not load: first line ');
	expect(kept[0]).not.toContain('second line');
	expect(kept[1]).toContain(`${'x'.repeat(1000)}...`);
	expect(kept[2]).toContain('did not load: bad (-2)');
	expect(kept[3]).toContain('Renderer ended: crashed; exit code 1.');
	expect(kept[3]).not.toContain('yyy');
	expect(kept[4]).toContain('Invalid structured input; payload details omitted.');
	expect(kept[5]).toContain('[credential header omitted]');
	expect(kept[5]).not.toContain('abc.def');
});

test('a journal write that fails does not throw out of the event', () => {
	const contents = fakeContents();
	watchWindowHealth(
		contents,
		() => Promise.reject(new Error('journal down')),
		() => {},
		() => LAST,
	);
	expect(() => contents.emit('unresponsive')).not.toThrow();
});

const state: PageState = {
	scrollX: 0,
	scrollY: 1182.4,
	bodyWidth: 2251,
	bodyHeight: 2492,
	viewWidth: 2251,
	viewHeight: 1310,
	focused: 'textarea.xterm-helper-textarea',
};

test('the last page state reads with its age, or says none was ever received', () => {
	expect(lastPageText({ at: 10_000, state }, 14_400)).toBe(
		'Last page state, 4 s old: page moved by 0, 1182 px; page 2251x2492, window 2251x1310; focus on textarea.xterm-helper-textarea.',
	);
	expect(lastPageText(null, 14_400)).toBe(
		'Last page state: unavailable, none was received from the page.',
	);
});

test('a page state from the renderer is checked before it is kept', () => {
	expect(pageStateFrom(state)).toEqual(state);
	expect(pageStateFrom({ ...state, focused: 'div<script>' })?.focused).toBe('divscript');
	for (const bad of [
		null,
		'x',
		{ ...state, scrollY: 'far' },
		{ ...state, bodyWidth: Infinity },
		{ ...state, focused: 3 },
	])
		expect(pageStateFrom(bad)).toBeNull();
});

test('the page-shift line names the offset, sizes, focus, what reached past the window and the put-back', () => {
	const extent = { pageWidth: 2251, pageHeight: 2492, right: 40.4, bottom: 2491.6 };
	const back = { ...state, scrollX: 0, scrollY: 0 };
	expect(
		pageShiftText(
			state,
			{ ...extent, outermost: 'div#tooltip', innermost: 'div#tooltip' },
			back,
		),
	).toBe(
		"The window's page moved out of place, so its columns may look blank or cut off: page moved by 0, 1182 px; page 2251x2492, window 2251x1310; focus on textarea.xterm-helper-textarea; the page could scroll to 2251x2492; furthest past the window: div#tooltip, reaching 40 px across and 2492 px down. It was put back in place.",
	);
	expect(
		pageShiftText(state, { ...extent, outermost: 'body', innermost: 'form#room-form' }, back),
	).toContain('furthest past the window: body, innermost form#room-form, reaching 40 px across');
	expect(pageShiftText(state, { ...extent, outermost: '', innermost: '' }, back)).toContain(
		'the page could scroll to 2251x2492, with nothing in it reaching past the window.',
	);
	expect(pageShiftText(state, { ...extent, outermost: '', innermost: '' }, state)).toEndWith(
		'It could not be put back: it is still moved by 0, 1182 px.',
	);
});
