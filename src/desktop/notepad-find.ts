import {
	type FindMatch,
	findMatches,
	matchCountText,
	nearestMatch,
	stepMatch,
} from './notepad-find-match.ts';

/**
 * Find in the notepad (Phillip #7628): Ctrl+F opens a bar, every match is highlighted as you
 * type, Enter and Shift+Enter (or F3 and Shift+F3) step through them, Esc closes the bar and leaves
 * the current match selected in the editor. Highlight only: nothing here changes the note.
 *
 * A textarea cannot style part of its own text, so the editor gets a layer behind it that repeats
 * the text in transparent ink with the matches marked, laid out with the textarea's own computed
 * metrics and scrolled with it; the textarea goes transparent only while the bar is open. The
 * Markdown preview and the saved-copy view are ordinary DOM, so they use the CSS highlight API.
 */
export interface NotepadFind {
	bar: HTMLElement;
	editor: HTMLElement;
	open: () => void;
	close: (returnFocus: boolean) => void;
	refresh: () => void;
	/** Redraw the editor layer with the textarea's current metrics, without searching again. */
	relayout: () => void;
	step: (direction: 1 | -1) => void;
	isOpen: () => boolean;
}

interface Options {
	text: HTMLTextAreaElement;
	/** The visible DOM pane (preview or saved copy), or null while the editor is showing. */
	domPane: () => HTMLElement | null;
	/** Where focus goes when the bar closes and the editor is not showing. */
	focusBack: () => void;
}

/** At most this many matches are drawn at once; see `drawn`. */
const DRAWN = 1000;
/** Notes longer than this (in UTF-16 units) search after a pause in typing; see `schedule`. */
const LARGE_NOTE = 32 * 1024;
const TYPING_PAUSE_MS = 150;

const COPIED = [
	'font',
	'letterSpacing',
	'tabSize',
	'whiteSpace',
	'overflowWrap',
	'wordBreak',
	'paddingTop',
	'paddingRight',
	'paddingBottom',
	'paddingLeft',
	'borderTopWidth',
	'borderRightWidth',
	'borderBottomWidth',
	'borderLeftWidth',
	'borderRadius',
	'backgroundColor',
] as const;

export function setupNotepadFind({ text, domPane, focusBack }: Options): NotepadFind {
	const editor = document.createElement('div');
	editor.className = 'notepad-editor';
	const layer = document.createElement('div');
	layer.className = 'notepad-find-layer';
	layer.setAttribute('aria-hidden', 'true');
	editor.append(layer, text);
	const bar = document.createElement('div');
	bar.className = 'notepad-find';
	bar.setAttribute('role', 'search');
	bar.hidden = true;
	const input = document.createElement('input');
	input.type = 'text';
	input.placeholder = 'Find';
	input.setAttribute('aria-label', 'Find in note');
	input.spellcheck = false;
	const count = document.createElement('output');
	count.setAttribute('aria-live', 'polite');
	const button = (label: string, name: string, act: () => void): HTMLButtonElement => {
		const control = document.createElement('button');
		control.type = 'button';
		control.textContent = label;
		control.setAttribute('aria-label', name);
		control.addEventListener('click', act);
		return control;
	};
	const previous = button('Previous', 'Previous match', () => step(-1));
	const next = button('Next', 'Next match', () => step(1));
	const done = button('Close find', 'Close find', () => close(true));
	bar.append(input, count, previous, next, done);

	let matches: FindMatch[] = [];
	let current = -1;
	let segments: { node: Text; start: number }[] = [];
	let pending: ReturnType<typeof setTimeout> | undefined;

	function textSegments(pane: HTMLElement): { node: Text; start: number }[] {
		const segments: { node: Text; start: number }[] = [];
		const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
		let offset = 0;
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			segments.push({ node: node as Text, start: offset });
			offset += (node as Text).length;
		}
		return segments;
	}
	function toRange(segments: { node: Text; start: number }[], match: FindMatch): Range {
		const at = (offset: number, end: boolean) => {
			const segment =
				segments.findLast((candidate) =>
					end ? candidate.start < offset : candidate.start <= offset,
				) ?? segments[0];
			return { node: segment?.node, offset: offset - (segment?.start ?? 0) };
		};
		const range = document.createRange();
		const from = at(match.start, false);
		const to = at(match.end, true);
		if (from.node && to.node) {
			range.setStart(from.node, from.offset);
			range.setEnd(to.node, to.offset);
		}
		return range;
	}

	function search(from: number, reveal = true): void {
		clearTimeout(pending);
		pending = undefined;
		const pane = domPane();
		if (pane) {
			segments = textSegments(pane);
			matches = findMatches(
				segments.map((segment) => segment.node.data).join(''),
				input.value,
			);
		} else {
			segments = [];
			matches = findMatches(text.value, input.value);
		}
		current = nearestMatch(matches, from);
		paint(reveal);
	}
	/**
	 * Searching a note at the 256 KiB cap and redrawing every match took up to 700 ms a keystroke
	 * (80,000 marks for "e"; Morticia's review of d19323e). A large note therefore searches after a
	 * pause in typing, and Enter or F3 meanwhile searches at once before stepping.
	 */
	function schedule(run: () => void): void {
		clearTimeout(pending);
		pending = undefined;
		if (text.value.length <= LARGE_NOTE) run();
		else pending = setTimeout(run, TYPING_PAUSE_MS);
	}
	/** The matches drawn at once, around the current one; the count still covers every match. */
	function drawn(): [number, number] {
		const start = Math.max(0, Math.min(current - DRAWN / 2, matches.length - DRAWN));
		return [start, Math.min(matches.length, start + DRAWN)];
	}
	/** `reveal` scrolls the current match into view; an edit repaints without moving the view. */
	function paint(reveal = true): void {
		count.value = matchCountText(matches.length, current, input.value);
		previous.disabled = next.disabled = matches.length === 0;
		CSS.highlights.delete('notepad-find');
		CSS.highlights.delete('notepad-find-current');
		layer.replaceChildren();
		editor.toggleAttribute('data-finding', !bar.hidden && !domPane());
		if (bar.hidden) return;
		const pane = domPane();
		const [first, end] = drawn();
		if (pane) {
			const ranges = matches.slice(first, end).map((match) => toRange(segments, match));
			CSS.highlights.set('notepad-find', new Highlight(...ranges));
			const focus = ranges[current - first];
			if (focus) CSS.highlights.set('notepad-find-current', new Highlight(focus));
			if (reveal) revealRange(pane, focus);
			return;
		}
		const style = getComputedStyle(text);
		for (const property of COPIED) layer.style[property] = style[property];
		let at = 0;
		for (let index = first; index < end; index++) {
			const match = matches[index];
			if (!match) continue;
			const mark = document.createElement('mark');
			mark.textContent = text.value.slice(match.start, match.end);
			if (index === current) mark.dataset.current = '';
			layer.append(text.value.slice(at, match.start), mark);
			at = match.end;
		}
		// Two spare lines so the layer can always scroll as far as the textarea, which loses
		// height to a horizontal scrollbar when wrapping is off.
		layer.append(`${text.value.slice(at)}\n\n `);
		if (reveal) revealMark(layer.querySelector<HTMLElement>('mark[data-current]'));
		else syncScroll();
	}
	function revealMark(mark: HTMLElement | null): void {
		if (mark) {
			const top = mark.offsetTop;
			if (
				top < text.scrollTop ||
				top + mark.offsetHeight > text.scrollTop + text.clientHeight
			)
				text.scrollTop = Math.max(0, top - text.clientHeight / 3);
			const left = mark.offsetLeft;
			if (
				left < text.scrollLeft ||
				left + mark.offsetWidth > text.scrollLeft + text.clientWidth
			)
				text.scrollLeft = Math.max(0, left - text.clientWidth / 3);
		}
		syncScroll();
	}
	function revealRange(pane: HTMLElement, range: Range | undefined): void {
		if (!range) return;
		const box = range.getBoundingClientRect();
		const view = pane.getBoundingClientRect();
		if (box.top < view.top || box.bottom > view.bottom)
			pane.scrollTop += box.top - view.top - pane.clientHeight / 3;
	}
	function syncScroll(): void {
		layer.scrollTop = text.scrollTop;
		layer.scrollLeft = text.scrollLeft;
	}

	function open(): void {
		const selected = text.value.slice(text.selectionStart, text.selectionEnd);
		if (!domPane() && selected && !selected.includes('\n') && selected.length <= 200)
			input.value = selected;
		bar.hidden = false;
		input.focus();
		input.select();
		search(domPane() ? 0 : text.selectionStart);
	}
	function close(returnFocus: boolean): void {
		if (bar.hidden) return;
		if (pending) search(domPane() ? 0 : text.selectionStart, false);
		const match = matches[current];
		bar.hidden = true;
		paint();
		if (domPane()) {
			if (returnFocus) focusBack();
			return;
		}
		if (match) text.setSelectionRange(match.start, match.end);
		if (returnFocus) text.focus();
	}
	function step(direction: 1 | -1): void {
		if (bar.hidden) return;
		if (pending) search(domPane() ? 0 : text.selectionStart, false);
		current = stepMatch(matches.length, current, direction);
		paint();
	}
	function refresh(): void {
		if (bar.hidden) return;
		const from = matches[current]?.start ?? 0;
		schedule(() => search(from, false));
	}

	input.addEventListener('input', () =>
		schedule(() => search(domPane() ? 0 : text.selectionStart)),
	);
	input.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			step(event.shiftKey ? -1 : 1);
		} else if (event.key === 'Escape') {
			// Closes the bar, not the notepad: the dialog would otherwise take Esc as its own.
			event.preventDefault();
			event.stopPropagation();
			close(true);
		}
	});
	text.addEventListener('scroll', syncScroll);
	const relayout = (): void => {
		if (!bar.hidden) paint(false);
	};
	return { bar, editor, open, close, refresh, relayout, step, isOpen: () => !bar.hidden };
}
