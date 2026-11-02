import { expect, test } from 'bun:test';

import type { BoardItem } from '../src/board-model.ts';

import { blockerName, boardQuery, matchBoardItem } from '../src/desktop/board-search-match.ts';

function card(patch: Partial<BoardItem> = {}): BoardItem {
	return {
		id: '150ea87c-bfbf-45a6-bdd2-827ab67a4b06',
		title: 'Find retained cards',
		project: 'summon',
		owner: 'morgan',
		partner: 'jimmy',
		description: 'Literal [search] across the Board.',
		state: 'blocked',
		blockedOn: { kind: 'human', target: 'Phillip', reason: 'Decision needed' },
		evidence: ['Room #8353'],
		archived: false,
		createdAt: '2026-10-10T17:00:00.000Z',
		updatedAt: '2026-10-10T17:00:00.000Z',
		revision: 1,
		comments: [
			{
				at: '2026-10-10T17:01:00.000Z',
				actor: { kind: 'agent', id: 'alice' },
				revision: 1,
				body: 'Keyboard focus must survive refresh.',
			},
		],
		...patch,
	};
}

test('normalizes whitespace and case without interpreting a regular expression', () => {
	expect(boardQuery('  [SEARCH]\n')).toBe('[search]');
	expect(matchBoardItem(card(), '  [SEARCH] ')).toEqual({
		title: false,
		owner: false,
		text: ['description'],
	});
	expect(matchBoardItem(card(), '.*')).toBeNull();
	expect(matchBoardItem(card(), ' \n ')).toBeNull();
});

test('finds titles and owners, and reports hidden text locations once', () => {
	expect(matchBoardItem(card(), 'RETAINED')?.title).toBe(true);
	expect(matchBoardItem(card(), 'MORGAN')?.owner).toBe(true);
	for (const [query, location] of [
		['phillip', 'blocker'],
		['decision', 'blocker'],
		['8353', 'evidence'],
		['keyboard', 'comments'],
	] as const) {
		expect(matchBoardItem(card(), query)?.text).toEqual([location]);
	}
	const item = card({ title: 'needle', owner: 'needle', description: 'needle' });
	expect(matchBoardItem(item, 'needle')).toEqual({
		title: true,
		owner: true,
		text: ['description'],
	});
});

test('reads a task blocker as the title it displays, not the id it stores', () => {
	const blocking = card({
		id: 'aaaa1111-0000-4000-8000-000000000001',
		title: 'Ship the matcher',
	});
	const waiting = card({
		blockedOn: { kind: 'task', target: blocking.id, reason: 'After that lands' },
		description: '',
		id: 'bbbb2222-0000-4000-8000-000000000002',
		title: 'Wire the toolbar',
	});
	const board = [blocking, waiting];
	expect(blockerName(waiting, board)).toBe('Ship the matcher');
	expect(matchBoardItem(waiting, 'ship the', board)?.text).toEqual(['blocker']);
	expect(matchBoardItem(waiting, 'aaaa1111', board)).toBeNull();
	// Without the Board, or once the blocking card is gone, there is no name to read.
	expect(matchBoardItem(waiting, 'aaaa1111')).toBeNull();
	expect(blockerName(waiting, [waiting])).toBe('');
	expect(blockerName(card(), board)).toBe('Phillip');
});

test('matches archived content without changing the card or joining unrelated fields', () => {
	const item = card({ archived: true, blockedOn: null });
	const before = JSON.stringify(item);
	expect(matchBoardItem(item, 'keyboard')?.text).toEqual(['comments']);
	for (const query of ['jimmy', 'summon', '150ea87c', 'alice', 'blocked', 'cards literal'])
		expect(matchBoardItem(item, query)).toBeNull();
	expect(JSON.stringify(item)).toBe(before);
});
