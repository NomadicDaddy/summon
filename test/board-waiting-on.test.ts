import { expect, test } from 'bun:test';

import type { BoardItem } from '../src/board-model.ts';

import { waitingOnLabel } from '../src/desktop/board-ordering.ts';

function card(over: Partial<BoardItem> & Pick<BoardItem, 'id'>): BoardItem {
	return {
		archived: false,
		blockedOn: null,
		createdAt: '2026-09-28T00:00:00.000Z',
		description: '',
		evidence: [],
		owner: 'carl',
		partner: 'jimmy',
		state: 'ready',
		title: 'A card',
		updatedAt: '2026-09-28T00:00:00.000Z',
		...over,
	} as BoardItem;
}

test('a human blocker names the person, not an identifier', () => {
	const item = card({
		blockedOn: { kind: 'human', reason: 'needs the passphrase', target: 'phillip' },
		id: 'a',
		state: 'blocked',
	});
	expect(waitingOnLabel(item, [item])).toBe('Waiting on phillip');
});

test('a task blocker resolves to the blocking card title rather than its uuid', () => {
	const blocker = card({ id: 'f2e4f4ee', state: 'ready', title: 'Restore the protection bits' });
	const item = card({
		blockedOn: { kind: 'task', reason: 'the repair has to land first', target: 'f2e4f4ee' },
		id: 'a',
		state: 'blocked',
	});
	// The defect this replaces rendered the target verbatim, so assert the id is absent as well as
	// the title present - a label containing both would still be the thing that was wrong.
	const label = waitingOnLabel(item, [item, blocker]) ?? '';
	expect(label).toContain('Restore the protection bits');
	expect(label).not.toContain('f2e4f4ee');
});

test('a task blocker whose target is already done reports itself satisfied', () => {
	const blocker = card({ id: 'f2e4f4ee', state: 'done', title: 'Restore the protection bits' });
	const item = card({
		blockedOn: { kind: 'task', reason: 'the repair has to land first', target: 'f2e4f4ee' },
		id: 'a',
		state: 'blocked',
	});
	expect(waitingOnLabel(item, [item, blocker])).toContain('No longer blocked');
});

test('a task blocker resolves against cards the current owner filter would hide', () => {
	// The real case: carl's card blocked on dave's. Resolving against the visible subset would
	// fail exactly when a blocker crosses owners, which is most of the time.
	const blocker = card({ id: 'f2e4f4ee', owner: 'dave', title: "Dave's repair" });
	const item = card({
		blockedOn: { kind: 'task', reason: 'crosses owners', target: 'f2e4f4ee' },
		id: 'a',
		owner: 'carl',
		state: 'blocked',
	});
	expect(waitingOnLabel(item, [item, blocker])).toContain("Dave's repair");
});

test('a task blocker pointing at nothing says so rather than rendering a dangling id', () => {
	const item = card({
		blockedOn: { kind: 'task', reason: 'stale', target: 'missing' },
		id: 'a',
		state: 'blocked',
	});
	expect(waitingOnLabel(item, [item])).toBe('Waiting on a card that no longer exists');
});

test('an unblocked card has no waiting label at all', () => {
	expect(waitingOnLabel(card({ id: 'a' }), [])).toBeUndefined();
});
