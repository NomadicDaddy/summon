import type { BoardItem } from '../board-model.ts';

import { blockerLabelParts } from './board-search-view.ts';
import { marked } from './search-marks.ts';

/**
 * The part of a card that is disclosed on demand rather than rendered on the face of it.
 *
 * The card face carries what identifies the card and what it is waiting on. Everything else is
 * here, and it is not small: measured across the first fifteen real cards, descriptions ran 278-449
 * characters, blocker reasons 73-231, and evidence lines about 110 each. A card showing all of that
 * is a paragraph wearing a border, and six lanes of them is unreadable.
 *
 * But withholding it entirely was the wrong half of that trade, and Dave named the cost: the board
 * asks the operator to decide, and the reason for the decision was in the JSON the panel already
 * held and never on screen. So the operator read a title, learned nothing, and went to the CLI —
 * which is the board failing at its one job.
 */
function paragraph(className: string, text: string, query: string): HTMLElement {
	const node = document.createElement('p');
	node.className = className;
	node.append(...marked(text, query));
	return node;
}

/** One piece of a comment's byline, which wraps as a whole: never "revision" and "1" apart. */
function metaToken(text: string): HTMLElement {
	const token = document.createElement('span');
	token.className = 'board-card-comment-token';
	token.textContent = text;
	return token;
}

/** Whether this card has anything worth opening, so a card with nothing hidden gets no control. */
export function hasDetails(item: BoardItem): boolean {
	return (
		item.description.trim() !== '' ||
		(item.blockedOn?.reason.trim() ?? '') !== '' ||
		item.evidence.length > 0 ||
		item.comments.length > 0
	);
}

/**
 * The blocker label for the card face and the details heading, with the search term marked inside
 * the name the blocker displays and nowhere else in the label.
 * @param item The blocked card.
 * @param waitingOn The resolved blocker label, when the Board could resolve one.
 * @param blocker The name the label displays, as the search read it; empty marks nothing.
 * @param query The search term.
 * @returns The label's text and marks, in order.
 */
export function blockerLabel(
	item: BoardItem,
	waitingOn: string | undefined,
	blocker: string,
	query: string,
): (Node | string)[] {
	const label = waitingOn ?? `Waiting on ${item.blockedOn?.target ?? 'someone'}`;
	const parts = blockerLabelParts(label, query === '' ? '' : blocker);
	return [parts.lead, ...marked(parts.name, query), parts.tail];
}

/** Prefix marking a blocker the board can see is already satisfied. See `waitingOnLabel`. */
export const SATISFIED = 'No longer blocked';

/**
 * Builds the disclosed region. Ordered as the operator reads it: what the work is, why it is
 * stopped, then what is already known to be true — because the evidence is what makes a decision
 * safe to make, and it is the part that was hardest to reach.
 * @param item The card being rendered.
 * @param waitingOn The resolved blocker label, when the Board could resolve one.
 * @param query A search term to mark inside the region; empty marks nothing.
 * @returns The details region, ready to be appended hidden.
 */
export function buildCardDetails(
	item: BoardItem,
	waitingOn?: string,
	query = '',
	blocker = '',
): HTMLElement {
	const details = document.createElement('div');
	details.className = 'board-card-details';

	const description = item.description.trim();
	if (description !== '') details.append(paragraph('board-card-description', description, query));

	const reason = item.blockedOn?.reason.trim() ?? '';
	if (reason !== '') {
		const heading = document.createElement('h5');
		heading.append(...blockerLabel(item, waitingOn, blocker, query));
		if (waitingOn?.startsWith(SATISFIED)) heading.className = 'board-card-waiting-satisfied';
		else if (item.blockedOn?.kind === 'human') heading.className = 'board-card-waiting-human';
		details.append(heading, paragraph('board-card-reason', reason, query));
	}

	if (item.evidence.length > 0) {
		const heading = document.createElement('h5');
		heading.textContent = 'Evidence';
		const list = document.createElement('ul');
		list.className = 'board-card-evidence';
		for (const line of item.evidence) {
			const entry = document.createElement('li');
			entry.append(...marked(line, query));
			list.append(entry);
		}
		details.append(heading, list);
	}
	if (item.comments.length > 0) {
		const heading = document.createElement('h5');
		heading.textContent = 'Comments';
		const list = document.createElement('ol');
		list.className = 'board-card-comments';
		for (const comment of item.comments) {
			const entry = document.createElement('li');
			const author = document.createElement('div');
			author.className = 'board-card-comment-meta';
			const timestamp = document.createElement('time');
			timestamp.className = 'board-card-comment-token';
			timestamp.dateTime = comment.at;
			timestamp.textContent = new Date(comment.at).toLocaleString(undefined, {
				timeZoneName: 'short',
			});
			author.append(
				metaToken(`${comment.actor.id} (${comment.actor.kind})`),
				' · ',
				timestamp,
				' · ',
				metaToken(`revision ${String(comment.revision)}`),
			);
			entry.append(author, paragraph('board-card-comment-body', comment.body, query));
			list.append(entry);
		}
		details.append(heading, list);
	}
	return details;
}

/**
 * Turns a card's title into the control that opens its details.
 *
 * The title rather than the whole card, deliberately: the card already carries action buttons, and
 * a clickable container wrapping its own buttons is the pattern that produces an archive nobody
 * meant to press. A button with `aria-expanded` is also the disclosure pattern assistive technology
 * already understands, so it needs no explaining and no key handler of its own.
 * @param title The card's heading, which becomes the control.
 * @param details The region it opens.
 */
export function wireDisclosure(title: HTMLElement, details: HTMLElement): HTMLElement {
	const control = document.createElement('button');
	control.type = 'button';
	control.className = 'board-card-disclosure';
	control.setAttribute('aria-expanded', 'false');
	control.textContent = title.textContent;
	control.addEventListener('click', () => {
		const open = control.getAttribute('aria-expanded') === 'true';
		control.setAttribute('aria-expanded', String(!open));
		details.hidden = open;
	});
	title.replaceChildren(control);
	return title;
}
