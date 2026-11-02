import type { BoardItem } from '../board-model.ts';
import type { BoardMatch } from './board-search-match.ts';
import type { BoardMove } from './types.ts';

import {
	actionHelp,
	chooseBoardOwner,
	confirmBoardAction,
	OWNER_DETAIL,
	OWNER_LABEL,
} from './board-action-help.ts';
import {
	blockerLabel,
	buildCardDetails,
	hasDetails,
	SATISFIED,
	wireDisclosure,
} from './board-card-details.ts';
import { marked } from './search-marks.ts';

/**
 * The three moves Phillip named in #1146 - "move them by approving or returning to backlog or
 * archiving". Verbs rather than drag: it is what he asked for literally, it needs no drag-and-drop
 * dependency, and buttons are keyboard-operable by construction rather than by retrofit.
 *
 * Each takes the revision the card was rendered at. That is not ceremony - an agent can be editing
 * the same card while the operator reads it, and the expected revision is the only thing standing
 * between a stale click and a silently lost update.
 */
export interface BoardActions {
	approve: (id: string, expectedRevision: number) => Promise<void>;
	archive: (id: string, expectedRevision: number) => Promise<void>;
	changeOwner: (id: string, expectedRevision: number, owner: string) => Promise<void>;
	promote: (id: string, expectedRevision: number) => Promise<void>;
	returnToBacklog: (id: string, expectedRevision: number) => Promise<void>;
	/** The registered teammates a card can be given to. */
	teammates: () => { name: string; slug: string }[];
	unblock: (id: string, expectedRevision: number) => Promise<void>;
}

/** What a search found on one card, and the term to mark. Absent when nothing is searched for. */
export interface CardSearch {
	/** The name the card's blocker displays, as the search read it. Empty without a blocker. */
	blocker: string;
	match: BoardMatch | null;
	query: string;
}

function buildAction(
	item: BoardItem,
	move: BoardMove,
	run: () => Promise<void>,
): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'board-card-action';
	button.textContent = actionHelp[move].label;
	button.title = actionHelp[move].detail;
	button.dataset['boardMove'] = move;
	button.addEventListener('click', () => {
		// Disabled for the round trip so a second click cannot fire against the revision the first
		// one is already superseding.
		button.disabled = true;
		void confirmBoardAction(item, move)
			.then(async (confirmed) => {
				if (confirmed) await run();
			})
			.finally(() => {
				button.disabled = false;
			});
	});
	return button;
}

/** Owner changes ask who, where the other moves only ask whether. */
function buildOwnerAction(item: BoardItem, actions: BoardActions): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'board-card-action';
	button.textContent = OWNER_LABEL;
	button.title = OWNER_DETAIL;
	button.dataset['boardMove'] = 'owner';
	button.addEventListener('click', () => {
		button.disabled = true;
		void chooseBoardOwner(item, actions.teammates())
			.then(async (owner) => {
				if (owner !== null) await actions.changeOwner(item.id, item.revision, owner);
			})
			.finally(() => {
				button.disabled = false;
			});
	});
	return button;
}

/**
 * What a card may show, decided by measurement rather than taste. Across the first five real cards
 * descriptions ran 278-449 characters, blocker reasons 73-231, and evidence lines about 110 each.
 * A card carrying all of that is a paragraph wearing a border, so the card shows what identifies
 * it and what it is waiting on, and the rest is disclosed on demand.
 *
 * A search keeps to that. A hit in the title or the owner is marked where it stands; a hit in the
 * folded text gets one line saying where, and the marks are inside when the card is opened. Cards
 * do not open themselves for a search, because a searched Board still has to read as lanes.
 */
export function buildCard(
	item: BoardItem,
	actions: BoardActions,
	waitingOn?: string,
	search?: CardSearch,
): HTMLElement {
	const query = search?.match ? search.query : '';
	const card = document.createElement('article');
	card.className = 'board-card';
	card.dataset['id'] = item.id;
	card.dataset['owner'] = item.owner;

	const title = document.createElement('h4');
	title.textContent = item.title;
	// A card with nothing hidden gets no control, so the arrow never promises something empty.
	const details = hasDetails(item)
		? buildCardDetails(item, waitingOn, query, search?.blocker)
		: null;
	let label: HTMLElement = title;
	if (details !== null) {
		details.hidden = true;
		wireDisclosure(title, details);
		label = title.querySelector<HTMLElement>('.board-card-disclosure') ?? title;
	}
	if (query !== '') label.replaceChildren(...marked(item.title, query));
	card.append(title);

	const meta = document.createElement('p');
	meta.className = 'board-card-meta';
	if (item.owner === '') meta.textContent = item.project;
	else meta.append(...marked(item.owner, query), ` · ${item.project}`);
	if (item.archived) {
		// An archived card is only ever here because a search found it; it keeps the lane of the
		// state it finished in, so the tag is what says it is no longer live work. It sits on the
		// owner line: after the title it wrapped onto a line of its own.
		card.classList.add('is-archived');
		const tag = document.createElement('span');
		tag.className = 'board-card-archived';
		tag.textContent = 'Archived';
		meta.append(tag);
	}
	card.append(meta);

	// The blocker is the only body text a card earns, because it is the reason the card is not
	// moving and the thing the operator is being asked to clear.
	if (item.blockedOn) {
		const blocked = document.createElement('p');
		blocked.className = 'board-card-blocked';
		blocked.append(...blockerLabel(item, waitingOn, search?.blocker ?? '', query));
		if (waitingOn?.startsWith(SATISFIED)) blocked.classList.add('board-card-waiting-satisfied');
		else if (item.blockedOn.kind === 'human') blocked.classList.add('board-card-waiting-human');
		blocked.title = item.blockedOn.reason;
		card.append(blocked);
	}

	if (item.comments.length > 0) {
		const count = document.createElement('span');
		count.className = 'board-card-count';
		count.textContent = `${String(item.comments.length)} comment${item.comments.length === 1 ? '' : 's'}`;
		card.append(count);
	}

	if (search?.match && search.match.text.length > 0) {
		const where = document.createElement('p');
		where.className = 'board-card-match';
		where.textContent = `Matches in ${search.match.text.join(', ')}`;
		card.append(where);
	}

	// Above the actions rather than below them, so opening a card does not push its own buttons out
	// from under the pointer that is about to use them.
	if (details !== null) card.append(details);

	// An archived card has no move left to make from here.
	if (!item.archived) {
		const row = document.createElement('div');
		row.className = 'board-card-actions';
		// Each move is offered only where it means something, which on this board is mostly the
		// first one: fourteen of the first fifteen cards were blocked on a decision and none were in
		// review. "Go ahead" clears that decision; only a human blocker is the operator's to clear,
		// because an agent or task blocker is cleared by the work finishing rather than by a click.
		if (item.blockedOn?.kind === 'human') {
			row.append(buildAction(item, 'unblock', () => actions.unblock(item.id, item.revision)));
		}
		// A Backlog card nothing is waiting on had no way out of Backlog from here (#9972). An
		// unowned card is given an owner first: the store starts no work without one.
		if (item.state === 'backlog' && item.blockedOn === null && item.owner !== '') {
			row.append(buildAction(item, 'promote', () => actions.promote(item.id, item.revision)));
		}
		// Operator acceptance supplies its own attributed evidence when the card has none.
		if (item.state === 'review') {
			row.append(buildAction(item, 'approve', () => actions.approve(item.id, item.revision)));
		}
		if (item.state !== 'backlog') {
			row.append(
				buildAction(item, 'backlog', () => actions.returnToBacklog(item.id, item.revision)),
			);
		}
		if (item.state !== 'done') row.append(buildOwnerAction(item, actions));
		row.append(buildAction(item, 'archive', () => actions.archive(item.id, item.revision)));
		card.append(row);
	}
	return card;
}
