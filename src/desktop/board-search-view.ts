import type { BoardItem } from '../board-model.ts';
import type { BoardMatch } from './board-search-match.ts';

import { matchBoardItem } from './board-search-match.ts';

/** What the search controls say: the term, and the two views it can be looked at through. */
export interface BoardSearchState {
	/** Show only the cards that match, or every card with the matches marked. */
	matchesOnly: boolean;
	query: string;
	/** Whether archived cards that match are shown. Archived cards never show without a term. */
	withArchived: boolean;
}

export interface BoardSelection {
	/** Matching archived cards among `visible`. */
	archivedMatched: number;
	/** Matching cards among `visible`. */
	matched: number;
	/** Where each visible matching card matched, by card id. Empty when there is no term. */
	matches: Map<string, BoardMatch>;
	visible: BoardItem[];
}

/**
 * Which cards the Board shows, and which of them match (card 150ea87c, Phillip #8353).
 *
 * With no term this is the Board as it always was: live cards, narrowed to the selected teammate.
 * A term changes two things on purpose. It searches every owner, because "where is that card" is
 * answered wrongly by a search that silently skips everyone but the teammate selected in the
 * roster. And it reaches archived cards, which are otherwise never shown, because a card someone
 * is looking for has often already finished - but only the archived cards that match, in either
 * view: listing every archived card beside the live ones would bury the Board under its own
 * history.
 */
export function selectBoardCards(
	items: readonly BoardItem[],
	selectedOwner: null | string,
	search: BoardSearchState,
	shown: null | string = null,
): BoardSelection {
	const matches = new Map<string, BoardMatch>();
	// One card can be asked for by id (Jump, card e6619a2e). It is shown whatever the owner filter
	// or the search would have done with it, archived or not, so "go to this card" always lands.
	const wanted = shown === null ? undefined : items.find((item) => item.id === shown);
	const withShown = (visible: BoardItem[]): BoardItem[] =>
		wanted === undefined || visible.includes(wanted) ? visible : [...visible, wanted];
	if (search.query.trim() === '') {
		const visible = items.filter(
			(item) => !item.archived && (selectedOwner === null || item.owner === selectedOwner),
		);
		return { archivedMatched: 0, matched: 0, matches, visible: withShown(visible) };
	}
	const visible: BoardItem[] = [];
	let archivedMatched = 0;
	for (const item of items) {
		if (item.archived && !search.withArchived) continue;
		const match = matchBoardItem(item, search.query, items);
		if (match === null) {
			if (!search.matchesOnly && !item.archived) visible.push(item);
			continue;
		}
		matches.set(item.id, match);
		if (item.archived) archivedMatched += 1;
		visible.push(item);
	}
	return { archivedMatched, matched: matches.size, matches, visible: withShown(visible) };
}

const plural = (count: number, noun: string): string =>
	`${String(count)} ${noun}${count === 1 ? '' : 's'}`;

/**
 * A card's blocker label, split so a search marks only what it searched (Roger #8392). The search
 * reads the name the blocker displays (`blockerName`), never the words around it, so "waiting"
 * marks nothing here. `name` is empty when the label does not carry it.
 *
 * A blocking card's title is shown in quotation marks, and the words after it can repeat it: a
 * finished card titled "done" reads “done” is done. The quoted occurrence is the name, so it is
 * looked for first (Morticia #8430); a person's name is not quoted and ends the label.
 */
export function blockerLabelParts(
	label: string,
	name: string,
): { lead: string; name: string; tail: string } {
	if (name === '') return { lead: label, name: '', tail: '' };
	const quoted = label.indexOf(`“${name}”`);
	const at = quoted === -1 ? label.lastIndexOf(name) : quoted + 1;
	if (at === -1) return { lead: label, name: '', tail: '' };
	return { lead: label.slice(0, at), name, tail: label.slice(at + name.length) };
}

/**
 * The status line under the search field. Empty without a term, so the Board reads as it did. It
 * always says the search covered every owner, because that is the one thing a term changes that
 * the lanes themselves cannot show.
 */
export function boardSearchStatus(search: BoardSearchState, selection: BoardSelection): string {
	if (search.query.trim() === '') return '';
	const archived = search.withArchived
		? selection.archivedMatched > 0
			? ` · ${String(selection.archivedMatched)} archived`
			: ''
		: ' · live cards only';
	if (selection.matched === 0) {
		// All cards still lists every owner's live cards, so it says so (Morticia #8412).
		if (!search.matchesOnly) return `All cards · no matches · all owners${archived}`;
		return search.withArchived
			? 'No cards match your search.'
			: 'No live cards match your search.';
	}
	const found = `${plural(selection.matched, 'card')} match${selection.matched === 1 ? 'es' : ''} · all owners${archived}`;
	return search.matchesOnly ? found : `All cards · matches marked · ${found}`;
}
