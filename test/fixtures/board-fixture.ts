import type { BoardItem, BoardSnapshot } from '../../src/board-model.ts';
import type { BoardActions } from '../../src/desktop/board-card.ts';

import { setupBoardToggle } from '../../src/desktop/board-panel.ts';

/** Shared by the rendered Board fixtures: card records, inert actions, and opening the Board. */
export const at = '2026-10-18T17:00:00.000Z';
let serial = 0;

export function card(
	state: BoardItem['state'],
	title: string,
	owner: string,
	extra: Partial<BoardItem> = {},
): BoardItem {
	serial += 1;
	return {
		archived: false,
		blockedOn: null,
		comments: [],
		createdAt: at,
		description: 'Enough description that the card has details to open.',
		evidence: [],
		id: `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
		owner,
		partner: '',
		project: 'summon',
		revision: 1,
		state,
		title,
		updatedAt: at,
		...extra,
	};
}

const done = async (): Promise<void> => {};
const actions: BoardActions = {
	approve: done,
	archive: done,
	changeOwner: done,
	promote: done,
	returnToBacklog: done,
	teammates: () => [],
	unblock: done,
};

/** Opens the real Board on these cards, with the Room beside it when the address says `?room`. */
export function showBoard(items: BoardItem[]): void {
	if (location.search === '?room') {
		document.body.classList.add('room-open');
		const room = document.getElementById('room');
		if (room) room.hidden = false;
	}
	const snapshot: BoardSnapshot = { items, revision: 1 };
	setupBoardToggle(
		() => Promise.resolve(snapshot),
		() => null,
		actions,
	);
	document.getElementById('board-toggle')?.click();
}
