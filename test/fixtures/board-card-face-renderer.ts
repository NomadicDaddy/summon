import { marked } from '../../src/desktop/search-marks.ts';
import { at, card, showBoard } from './board-fixture.ts';

/*
 * Team-board clauses 36, 38 and 43: a card's comment metadata, its comment count and its disclosure
 * caret, on six populated lanes. The comment authors run from one to twenty characters and the
 * revisions from 1 to 20, so the metadata lines reach every wrapping offset a lane can give them;
 * the caret is tried after every prefix of a long title, plain and with the last word marked by a
 * search, for the same reason. `?room` opens the Room beside the Board.
 */
const MARKER = 'BOARD_FACE';
const names = 'stewardmorticiajimmy';
const comments = Array.from({ length: 20 }, (_, index) => ({
	actor: { id: names.slice(0, index + 1), kind: index % 3 === 0 ? 'operator' : 'agent' } as const,
	at,
	body: 'Seen.',
	revision: index + 1,
}));
const target = card('review', 'Keep the comment metadata whole when the lane is narrow', 'jimmy', {
	comments,
});
// Nothing to disclose: no control and no count, so neither promises something empty.
const plain = card('done', 'Header facts parity', 'erin', { description: '' });
showBoard([
	card('backlog', 'Quiet card with no hit', 'alice'),
	card('ready', 'Scan the binder manual', 'dave'),
	card('doing', 'Give Board search the Diary treatment', 'morgan'),
	card('blocked', 'Sign the installer', 'hugo', {
		blockedOn: { kind: 'human', reason: 'Needs a certificate.', target: 'phillip' },
	}),
	target,
	plain,
]);

function frame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function until(test: () => boolean): Promise<boolean> {
	for (let tries = 0; tries < 120; tries += 1) {
		if (test()) return true;
		await frame();
	}
	return test();
}

function shown(node: Element | null): boolean {
	return node !== null && node.getClientRects().length > 0;
}

/** How many line boxes a stretch of text occupies. */
function lines(range: Range): number {
	const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
	return new Set(rects.map((rect) => Math.round(rect.top))).size;
}

/** The range covering the first occurrence of `text` in an element, across its text nodes. */
function rangeOf(root: Element, text: string): Range | null {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: { node: Text; start: number }[] = [];
	let flat = '';
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
		const data = (node as Text).data;
		nodes.push({ node: node as Text, start: flat.length });
		flat += data;
	}
	const start = flat.indexOf(text);
	if (start < 0 || text === '') return null;
	const end = start + text.length;
	const find = (offset: number, closing: boolean): { node: Text; start: number } | undefined =>
		nodes.find(
			({ node, start: first }) =>
				offset >= first &&
				(closing ? offset <= first + node.data.length : offset < first + node.data.length),
		);
	const head = find(start, false);
	const tail = find(end, true);
	if (!head || !tail) return null;
	const range = document.createRange();
	range.setStart(head.node, start - head.start);
	range.setEnd(tail.node, end - tail.start);
	return range;
}

/** Whether the caret sits on a line below the title's last character. */
function caretAlone(control: HTMLElement): boolean {
	const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
	let last: Text | null = null;
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
		if ((node as Text).data !== '') last = node as Text;
	}
	if (last === null) return false;
	const range = document.createRange();
	range.setStart(last, last.data.length - 1);
	range.setEnd(last, last.data.length);
	const rect = [...range.getClientRects()].at(-1);
	if (!rect) return false;
	const lineHeight = parseFloat(getComputedStyle(control).lineHeight) || 16;
	return control.getBoundingClientRect().bottom - rect.bottom > lineHeight / 2;
}

/** Every prefix of a long title, plain and with its last word marked, under the caret. */
function sweepCaret(control: HTMLElement): { alone: number; aloneMarked: number; tried: number } {
	const original = [...control.childNodes];
	const words =
		'Keep the disclosure caret with the final word of a long card title as the lane narrows and wraps it onto a third line'.split(
			' ',
		);
	let alone = 0;
	let aloneMarked = 0;
	for (let count = 1; count <= words.length; count += 1) {
		const title = words.slice(0, count).join(' ');
		control.replaceChildren(title);
		if (caretAlone(control)) alone += 1;
		control.replaceChildren(...marked(title, words[count - 1] ?? ''));
		if (caretAlone(control)) aloneMarked += 1;
	}
	control.replaceChildren(...original);
	return { alone, aloneMarked, tried: words.length };
}

/** The width a stretch of text takes on one line in this element's font, to the subpixel. */
function singleLineWidth(host: HTMLElement, text: string): number {
	const probe = document.createElement('span');
	probe.style.cssText = 'position: absolute; visibility: hidden; white-space: nowrap';
	probe.textContent = text;
	host.append(probe);
	const width = probe.getBoundingClientRect().width;
	probe.remove();
	return width;
}

function contentWidth(node: HTMLElement): number {
	const style = getComputedStyle(node);
	return (
		node.getBoundingClientRect().width -
		parseFloat(style.paddingLeft) -
		parseFloat(style.paddingRight) -
		parseFloat(style.borderLeftWidth) -
		parseFloat(style.borderRightWidth)
	);
}

/**
 * Each comment's author, time and revision, and whether any of them broke across lines. A token
 * wider than the whole column has to wrap inside itself and is counted apart, as `oversize`; only
 * one that would have fitted on a line of its own counts as broken.
 */
function measureTokens(details: Element): {
	broken: number;
	checked: number;
	examples: string[];
	overflow: number;
	oversize: number;
} {
	const broken: string[] = [];
	let checked = 0;
	let overflow = 0;
	let oversize = 0;
	const metas = [...details.querySelectorAll<HTMLElement>('.board-card-comment-meta')];
	metas.forEach((meta, index) => {
		const comment = comments[index];
		if (!comment) return;
		if (meta.scrollWidth > meta.clientWidth + 1) overflow += 1;
		const tokens = [
			`${comment.actor.id} (${comment.actor.kind})`,
			meta.querySelector('time')?.textContent ?? '',
			`revision ${String(comment.revision)}`,
		];
		for (const token of tokens) {
			const range = rangeOf(meta, token);
			if (!range) continue;
			checked += 1;
			if (lines(range) <= 1) continue;
			if (singleLineWidth(meta, token) > contentWidth(meta)) oversize += 1;
			else broken.push(token);
		}
	});
	return { broken: broken.length, checked, examples: broken.slice(0, 4), overflow, oversize };
}

/** The space between two boxes along whichever axis separates them: beside or above each other. */
function spaceBetween(a: DOMRect, b: DOMRect): number {
	const across = Math.max(b.left - a.right, a.left - b.right);
	const down = Math.max(b.top - a.bottom, a.top - b.bottom);
	return Math.max(across, down);
}

/**
 * The first action's keyboard focus ring against the nearest other action, beside or below it: how
 * far the ring reaches past the button's edge (outline width plus offset) and the gap it has to stay
 * inside. Focusing alone was seen not to match `:focus-visible` in the hidden fixture window, so
 * the harness forces it through DevTools, which applies the whole cascade and the paint.
 * A ring is read only while one is drawn; with no outline Chromium still reports the default 3px
 * width, which would pass for a ring that is not there.
 */
async function focusRing(face: HTMLElement): Promise<{
	clear: boolean;
	gap: number;
	pageFocused: boolean;
	reach: number;
	style: string;
} | null> {
	const [action, ...others] = [...face.querySelectorAll<HTMLElement>('.board-card-action')];
	if (!action || others.length === 0) return null;
	const box = action.getBoundingClientRect();
	const space = Math.min(
		...others.map((other) => spaceBetween(box, other.getBoundingClientRect())),
	);
	const gap = Math.round(space * 10) / 10;
	// Left forced, so a recorded screenshot shows the ring itself.
	action.dataset['boardFocusProbe'] = '';
	document.title = `${MARKER}_FOCUS 1`;
	await until(() => getComputedStyle(action).outlineStyle !== 'none');
	const outline = getComputedStyle(action);
	const drawn = outline.outlineStyle !== 'none';
	const width = drawn ? parseFloat(outline.outlineWidth) : 0;
	const reach = Math.max(0, width + (drawn ? parseFloat(outline.outlineOffset) : 0));
	const pageFocused = document.hasFocus();
	return { clear: reach < gap, gap, pageFocused, reach, style: outline.outlineStyle };
}

async function measure(): Promise<void> {
	await until(() => document.querySelectorAll('.board-lane').length === 6);
	const board = document.getElementById('board');
	const lanes = [...document.querySelectorAll<HTMLElement>('.board-lane')];
	const face = document.querySelector<HTMLElement>(`.board-card[data-id="${target.id}"]`);
	const control = face?.querySelector<HTMLElement>('.board-card-disclosure');
	const details = face?.querySelector<HTMLElement>('.board-card-details');
	if (!board || !face || !control || !details) {
		document.title = `${MARKER} ${JSON.stringify({ error: 'Board did not render' })}`;
		return;
	}
	const count = face.querySelector('.board-card-count');
	const widths = (): number[] =>
		lanes.map((lane) => Math.round(lane.getBoundingClientRect().width * 10) / 10);
	const closedWidths = widths();
	const countClosed = shown(count);

	// Opened by a real Enter on the focused title, as a keyboard user opens it.
	control.focus();
	document.title = `${MARKER}_KEY 1`;
	const keyboardOpened = await until(() => control.getAttribute('aria-expanded') === 'true');
	if (!keyboardOpened) control.click();
	await frame();
	const countOpen = shown(count);
	const detailsShown = shown(details);
	const laneWidthsStable = JSON.stringify(widths()) === JSON.stringify(closedWidths);
	const tokens = measureTokens(details);
	// Long open content may scroll inside its lane; the card's own actions must still be reachable.
	const actionsRow = face.querySelector('.board-card-actions');
	actionsRow?.scrollIntoView({ block: 'nearest' });
	await frame();
	const lane = face.closest('.board-lane')?.getBoundingClientRect();
	const reach = actionsRow?.getBoundingClientRect();
	const actionsReachable =
		lane !== undefined &&
		reach !== undefined &&
		reach.height > 0 &&
		reach.top >= lane.top &&
		reach.bottom <= Math.min(lane.bottom, innerHeight);

	control.click();
	await frame();
	const countClosedAgain = shown(count);
	const caret = sweepCaret(control);
	const ring = await focusRing(face);
	const page = document.scrollingElement;
	const plainFace = document.querySelector(`.board-card[data-id="${plain.id}"]`);
	document.title = `${MARKER} ${JSON.stringify({
		actionsReachable,
		boardOverflowX: board.scrollWidth > board.clientWidth,
		caret,
		count: { closed: countClosed, closedAgain: countClosedAgain, open: countOpen },
		detailsShown,
		focusRing: ring,
		keyboardOpened,
		laneWidth: Math.round(face.getBoundingClientRect().width),
		laneWidthsStable,
		pageFits: page ? page.scrollHeight <= innerHeight : false,
		plain: plainFace
			? {
					count: plainFace.querySelector('.board-card-count') !== null,
					disclosure: plainFace.querySelector('.board-card-disclosure') !== null,
				}
			: null,
		tokens,
	})}`;
}
void measure();
