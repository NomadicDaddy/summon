import { describe, expect, test } from 'bun:test';

import type { BoardItem } from '../src/board-model.ts';
import type { BoardSearchState } from '../src/desktop/board-search-view.ts';

import {
	blockerLabelParts,
	boardSearchStatus,
	selectBoardCards,
} from '../src/desktop/board-search-view.ts';

/*
 * Which cards the Board shows for a search, and what its status line says (card 150ea87c). The
 * drawing itself is DOM work and is verified in the built window (summon has no DOM in bun:test),
 * with the record under scratch/shared/jimmy/board-search.
 */
function card(id: string, patch: Partial<BoardItem> = {}): BoardItem {
	return {
		archived: false,
		blockedOn: null,
		comments: [],
		createdAt: '2026-10-10T17:00:00.000Z',
		description: '',
		evidence: [],
		id,
		owner: 'morgan',
		partner: '',
		project: 'summon',
		revision: 1,
		state: 'ready',
		title: `Card ${id}`,
		updatedAt: '2026-10-10T17:00:00.000Z',
		...patch,
	};
}
const items = [
	card('live-hit', { title: 'Alpha checklist' }),
	card('live-miss', { owner: 'carl', title: 'Rotate the list' }),
	card('other-owner-hit', { description: 'the alpha build', owner: 'carl' }),
	card('archived-hit', { archived: true, state: 'done', title: 'Alpha notes shipped' }),
	card('archived-miss', { archived: true, state: 'done', title: 'Old chore' }),
];
const search = (patch: Partial<BoardSearchState> = {}): BoardSearchState => ({
	matchesOnly: true,
	query: 'alpha',
	withArchived: true,
	...patch,
});
const ids = (selection: { visible: BoardItem[] }): string[] =>
	selection.visible.map((item) => item.id);

describe('selectBoardCards without a term', () => {
	test('is the Board as it was: live cards, narrowed to the selected teammate', () => {
		const none = search({ query: '   ' });
		expect(ids(selectBoardCards(items, null, none))).toEqual([
			'live-hit',
			'live-miss',
			'other-owner-hit',
		]);
		const narrowed = selectBoardCards(items, 'carl', none);
		expect(ids(narrowed)).toEqual(['live-miss', 'other-owner-hit']);
		expect(narrowed.matches.size).toBe(0);
		expect(boardSearchStatus(none, narrowed)).toBe('');
	});
});

describe('selectBoardCards with a term', () => {
	test('searches every owner and reaches archived cards that match', () => {
		const selection = selectBoardCards(items, 'morgan', search());
		expect(ids(selection)).toEqual(['live-hit', 'other-owner-hit', 'archived-hit']);
		expect(selection.matched).toBe(3);
		expect(selection.archivedMatched).toBe(1);
		expect(selection.matches.get('other-owner-hit')?.text).toEqual(['description']);
		expect(boardSearchStatus(search(), selection)).toBe(
			'3 cards match · all owners · 1 archived',
		);
	});

	test('Live only leaves archived cards out and says so', () => {
		const state = search({ withArchived: false });
		const selection = selectBoardCards(items, null, state);
		expect(ids(selection)).toEqual(['live-hit', 'other-owner-hit']);
		expect(boardSearchStatus(state, selection)).toBe(
			'2 cards match · all owners · live cards only',
		);
	});

	test('All cards keeps every live card and adds only the archived ones that match', () => {
		const state = search({ matchesOnly: false });
		const selection = selectBoardCards(items, 'morgan', state);
		expect(ids(selection)).toEqual([
			'live-hit',
			'live-miss',
			'other-owner-hit',
			'archived-hit',
		]);
		expect(selection.matches.has('live-miss')).toBe(false);
		expect(boardSearchStatus(state, selection)).toBe(
			'All cards · matches marked · 3 cards match · all owners · 1 archived',
		);
	});

	test('one match is singular, and no match is said plainly in both archive views', () => {
		const one = search({ query: 'checklist' });
		expect(boardSearchStatus(one, selectBoardCards(items, null, one))).toBe(
			'1 card matches · all owners',
		);
		const none = search({ query: 'zzzz' });
		const empty = selectBoardCards(items, null, none);
		expect(empty.visible).toEqual([]);
		expect(boardSearchStatus(none, empty)).toBe('No cards match your search.');
		const live = search({ query: 'shipped', withArchived: false });
		expect(boardSearchStatus(live, selectBoardCards(items, null, live))).toBe(
			'No live cards match your search.',
		);
	});

	test('a blocker label offers only the displayed name for marking', () => {
		expect(blockerLabelParts('Waiting on phillip', 'phillip')).toEqual({
			lead: 'Waiting on ',
			name: 'phillip',
			tail: '',
		});
		expect(
			blockerLabelParts('No longer blocked — “Ship the matcher” is done', 'Ship the matcher'),
		).toEqual({ lead: 'No longer blocked — “', name: 'Ship the matcher', tail: '” is done' });
		// A title repeated in the words after it: the quoted one is the name (Morticia #8430).
		expect(blockerLabelParts('No longer blocked — “done” is done', 'done')).toEqual({
			lead: 'No longer blocked — “',
			name: 'done',
			tail: '” is done',
		});
		expect(blockerLabelParts('Waiting on “Waiting on review”', 'Waiting on review')).toEqual({
			lead: 'Waiting on “',
			name: 'Waiting on review',
			tail: '”',
		});
		// A label that does not carry the name, or a blocker with none, offers nothing to mark.
		expect(blockerLabelParts('Waiting on a card that no longer exists', '')).toEqual({
			lead: 'Waiting on a card that no longer exists',
			name: '',
			tail: '',
		});
	});

	test('a task blocker is found by the title it displays, never by the id it stores', () => {
		const board = [
			...items,
			card('queued', {
				blockedOn: { kind: 'task', reason: 'After that lands.', target: 'live-miss' },
				state: 'blocked',
				title: 'Queued work',
			}),
		];
		const byTitle = selectBoardCards(board, null, search({ query: 'rotate the' }));
		expect(byTitle.matches.get('queued')).toEqual({
			owner: false,
			text: ['blocker'],
			title: false,
		});
		expect(byTitle.matches.get('live-miss')?.title).toBe(true);
		expect(selectBoardCards(board, null, search({ query: 'live-miss' })).matched).toBe(0);
	});

	test('All cards with no match says it is every owner', () => {
		const all = search({ matchesOnly: false, query: 'zzzz' });
		const selection = selectBoardCards(items, 'morgan', all);
		expect(selection.visible.length).toBeGreaterThan(0);
		expect(boardSearchStatus(all, selection)).toBe('All cards · no matches · all owners');
		const live = search({ matchesOnly: false, query: 'zzzz', withArchived: false });
		expect(boardSearchStatus(live, selectBoardCards(items, null, live))).toBe(
			'All cards · no matches · all owners · live cards only',
		);
	});

	test('a card asked for by id is shown whatever the owner filter or the search did', () => {
		// Jump (card e6619a2e) passes the id as the fourth argument.
		const none = search({ query: '' });
		expect(ids(selectBoardCards(items, 'morgan', none))).toEqual(['live-hit']);
		expect(ids(selectBoardCards(items, 'morgan', none, 'live-miss'))).toEqual([
			'live-hit',
			'live-miss',
		]);
		// An archived card is never shown without a term, except the one asked for.
		expect(ids(selectBoardCards(items, 'morgan', none, 'archived-miss'))).toEqual([
			'live-hit',
			'archived-miss',
		]);
		// Already visible, or not on the Board at all: nothing is added.
		expect(ids(selectBoardCards(items, 'morgan', none, 'live-hit'))).toEqual(['live-hit']);
		expect(ids(selectBoardCards(items, 'morgan', none, 'gone'))).toEqual(['live-hit']);
		// Through a search that would have left it out, in the Live only view too.
		const live = search({ query: 'zzzz', withArchived: false });
		const selection = selectBoardCards(items, null, live, 'archived-miss');
		expect(ids(selection)).toEqual(['archived-miss']);
		// It is shown, not counted as a match.
		expect(selection.matched).toBe(0);
		expect(selection.matches.has('archived-miss')).toBe(false);
	});

	test('an owner name is a term like any other', () => {
		const selection = selectBoardCards(items, null, search({ query: 'CARL' }));
		expect(ids(selection)).toEqual(['live-miss', 'other-owner-hit']);
		expect(selection.matches.get('live-miss')).toEqual({ owner: true, text: [], title: false });
	});
});
