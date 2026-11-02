import type { JumpBoard, JumpCard, JumpPerson, JumpTarget } from './jump-resolve.ts';

import { dismissOnOutsideClick } from './dialog-dismiss.ts';
import { faultText, reportFault } from './fault-report.ts';
import { HELD_ENTER, heldChoice, jumpKey, jumpLabel, resolveJump } from './jump-resolve.ts';

/**
 * Jump (card e6619a2e): Ctrl+Shift+J opens one field, and what is typed there goes to a Room
 * message, a Board card or a teammate. jump-resolve.ts decides what an entry could mean; this file
 * is the box, its keys, and the going.
 *
 * It asks the rest of the window to do the going, the way a person would: a teammate is selected
 * by pressing their roster row, a message is shown by the room's own reference path, a card by the
 * Board's. So Jump holds no copy of how any of those work, and cannot drift from them.
 *
 * The roster is read from the sidebar and the Board through the call the Board panel already
 * makes. Nothing is fetched until the box opens, and nothing typed leaves the window.
 */
const element = (id: string): HTMLElement | null => document.getElementById(id);

function people(): JumpPerson[] {
	return [...document.querySelectorAll<HTMLElement>('#roster .member[data-slug]')].map((row) => ({
		name: row.querySelector('strong')?.textContent ?? row.dataset['slug'] ?? '',
		slug: row.dataset['slug'] ?? '',
	}));
}

/** Waits for a panel that has just been opened to draw, without waiting for ever. */
async function settled(ready: () => boolean): Promise<void> {
	for (let tries = 0; tries < 40 && !ready(); tries++)
		await new Promise((resolve) => setTimeout(resolve, 50));
}

/** A teammate's roster row, looked up afresh: the roster rebuilds its rows on every update. */
const rosterRow = (slug: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`#roster .member[data-slug="${CSS.escape(slug)}"]`);

/**
 * Where focus was when the box opened, as something that can be found again. A roster row is
 * replaced by a new node on every update, so the node itself may be gone by the time the box
 * closes; its teammate is still there.
 */
function remembered(): () => void {
	const held = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	const slug = held?.closest<HTMLElement>('#roster .member[data-slug]')?.dataset['slug'];
	return () => {
		if (held?.isConnected === true) held.focus();
		else if (slug !== undefined) rosterRow(slug)?.focus();
	};
}

async function go(target: JumpTarget): Promise<void> {
	if (target.kind === 'person') {
		const { slug } = target.person;
		rosterRow(slug)?.click();
		// A click with the mouse leaves focus on the row, or on the teammate's terminal when one is
		// running. Pressing it from here leaves focus nowhere, so the row is given it unless the
		// selection has already put it somewhere.
		await settled(() => rosterRow(slug)?.getAttribute('aria-current') === 'true');
		if (document.activeElement === document.body) rosterRow(slug)?.focus();
		return;
	}
	if (target.kind === 'card') {
		element('board')?.dispatchEvent(new CustomEvent('board-jump', { detail: target.card.id }));
		return;
	}
	const messages = element('room-messages');
	if (element('room')?.hidden === true) {
		element('room-toggle')?.click();
		// The room loads its recent messages as it opens; asked before they are drawn, a recent
		// message would be shown as a preview when it could have been shown in place.
		await settled(() => (messages?.childElementCount ?? 0) > 0);
	}
	messages?.dispatchEvent(new CustomEvent('room-jump', { detail: target.id }));
}

/** Builds the box and takes the shortcut. Called once, with the rest of the window's shortcuts. */
export function setupJump(): void {
	const dialog = document.createElement('dialog');
	dialog.id = 'jump';
	dialog.setAttribute('aria-labelledby', 'jump-title');
	const heading = document.createElement('h2');
	heading.id = 'jump-title';
	heading.textContent = 'Jump to';
	const input = document.createElement('input');
	input.id = 'jump-input';
	input.type = 'text';
	input.autocomplete = 'off';
	input.spellcheck = false;
	input.maxLength = 80;
	input.placeholder = 'Message number, card id or teammate';
	input.setAttribute('role', 'combobox');
	input.setAttribute('aria-controls', 'jump-list');
	input.setAttribute('aria-autocomplete', 'list');
	input.setAttribute('aria-labelledby', 'jump-title');
	const list = document.createElement('ul');
	list.id = 'jump-list';
	list.setAttribute('role', 'listbox');
	list.setAttribute('aria-label', 'Matches');
	const status = document.createElement('p');
	status.id = 'jump-status';
	status.setAttribute('role', 'status');
	dialog.append(heading, input, list, status);
	document.body.append(dialog);
	dismissOnOutsideClick(dialog);

	const HINT =
		'A number is a Room message, the start of an id is a Board card, a name is a teammate.';
	let cards: JumpCard[] = [];
	// The Board is read afresh each time the box opens. Until that read returns the cards are not
	// in hand, and the box says so rather than answering from the last opening or from nothing.
	let board: JumpBoard = 'loading';
	let opening = 0;
	let targets: JumpTarget[] = [];
	let pending = false;
	// A choice made while the Board was still being read: HELD_ENTER, or the match that was clicked.
	let held: null | string = null;
	let active = 0;
	let refocus = (): void => undefined;
	let jumped = false;

	const keyOf = (target: JumpTarget | undefined): string => (target ? jumpKey(target) : '');
	const mark = (): void => {
		for (const [index, option] of [...list.children].entries())
			option.setAttribute('aria-selected', String(index === active));
		const current = list.children[active];
		if (current) input.setAttribute('aria-activedescendant', current.id);
		else input.removeAttribute('aria-activedescendant');
		current?.scrollIntoView({ block: 'nearest' });
	};
	/** @param keep Keep the highlighted match where it is: the list changed under the reader. */
	const draw = (keep = false): void => {
		const highlighted = keep ? keyOf(targets[active]) : '';
		const answer = resolveJump(input.value, people(), cards, board);
		targets = answer.targets;
		pending = answer.pending;
		active = Math.max(
			0,
			targets.findIndex((target) => keyOf(target) === highlighted),
		);
		list.replaceChildren(
			...targets.map((target, index) => {
				const label = jumpLabel(target);
				const option = document.createElement('li');
				option.id = `jump-option-${String(index)}`;
				option.setAttribute('role', 'option');
				option.dataset['kind'] = target.kind;
				const kind = document.createElement('span');
				kind.className = 'jump-kind';
				kind.textContent = label.kind;
				const title = document.createElement('span');
				title.className = 'jump-title';
				title.textContent = label.title;
				const detail = document.createElement('span');
				detail.className = 'jump-detail';
				detail.textContent = label.detail;
				option.append(kind, title, detail);
				// mousedown, so the field does not lose focus before the choice is taken.
				option.addEventListener('mousedown', (event) => {
					event.preventDefault();
					choose(index, true);
				});
				return option;
			}),
		);
		input.setAttribute('aria-expanded', String(targets.length > 0));
		status.textContent =
			answer.nothing ||
			answer.note ||
			(answer.more > 0 ? `${String(answer.more)} more. Type more to narrow it down.` : '') ||
			(targets.length === 0 ? HINT : '');
		mark();
	};
	function choose(index: number, clicked = false): void {
		const target = targets[index];
		// Not while the Board is still being read for an entry that could be a card id: going now
		// could take a message or a teammate when the card was what was meant. The choice is kept
		// and settled when the read ends, by heldChoice: a clicked match is that match, and an
		// Enter goes only if exactly one thing matched.
		if (pending) {
			held = clicked && target ? jumpKey(target) : HELD_ENTER;
			return;
		}
		if (!target) return;
		jumped = true;
		dialog.close();
		go(target).catch((cause: unknown) => {
			reportFault({ level: 'error', source: 'jump.go', text: faultText(cause) });
		});
	}
	const open = (): void => {
		refocus = remembered();
		jumped = false;
		held = null;
		input.value = '';
		cards = [];
		board = 'loading';
		const ticket = ++opening;
		draw();
		dialog.showModal();
		input.focus();
		window.team
			.boardRead()
			.then((snapshot) => {
				if (ticket !== opening) return;
				cards = snapshot.items.map((item) => ({
					archived: item.archived,
					id: item.id,
					owner: item.owner,
					state: item.state,
					title: item.title,
				}));
				board = 'ready';
			})
			.catch((cause: unknown) => {
				if (ticket !== opening) return;
				board = 'failed';
				reportFault({ level: 'error', source: 'jump.board', text: faultText(cause) });
			})
			.finally(() => {
				if (ticket !== opening || !dialog.open) return;
				draw(true);
				const waited = held;
				held = null;
				const index = heldChoice(waited, targets.map(jumpKey), board);
				if (index >= 0) choose(index);
				// The box stays open on purpose, so it says why: the reader pressed Enter and
				// nothing went. A failed read already has its own line.
				else if (waited !== null && board === 'ready' && targets.length > 1)
					status.textContent =
						'The Board is read and more than one thing matches. Choose one.';
			});
	};
	input.addEventListener('input', () => {
		// Typing on withdraws a held choice: the entry it was made on is no longer the entry.
		held = null;
		draw();
	});
	input.addEventListener('keydown', (event) => {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (targets.length === 0) return;
			const step = event.key === 'ArrowDown' ? 1 : -1;
			active = (active + step + targets.length) % targets.length;
			mark();
		} else if (event.key === 'Enter') {
			event.preventDefault();
			choose(active);
		}
	});
	// Closed without going anywhere, focus returns to where it was; after a jump the destination
	// has taken it and must keep it.
	dialog.addEventListener('close', () => {
		if (!jumped) refocus();
	});
	document.addEventListener(
		'keydown',
		(event) => {
			if (!event.ctrlKey || !event.shiftKey || event.altKey || event.code !== 'KeyJ') return;
			// Taken before a terminal sees it: Ctrl+J is a line feed there, and a stray one in a
			// teammate's prompt is not what this key is for.
			event.preventDefault();
			event.stopImmediatePropagation();
			if (event.repeat) return;
			if (dialog.open) dialog.close();
			else if (document.querySelector('dialog[open]') === null) open();
		},
		true,
	);
}
