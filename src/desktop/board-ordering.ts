import type { BoardItem } from '../board-model.ts';

import { SATISFIED } from './board-card-details.ts';

/**
 * Within a lane, oldest first. The board holds no rank - there is no order field, and the ranked
 * list lives in next.md, which nothing reconciles with this. So the order has to be one that does
 * not imply a priority it cannot honour: `createdAt` ascending says "this has waited longest",
 * which on a board whose purpose is surfacing what waits on somebody is real information.
 */
export function byOldestFirst(a: BoardItem, b: BoardItem): number {
	return a.createdAt.localeCompare(b.createdAt);
}

/**
 * What a card is waiting on, in words the operator can act on.
 *
 * A task blocker stores the blocking card's id, and this heading rendered that id - so a card said
 * `waiting on f2e4f4ee-21cf-406c-b444-295d9d41ad7d` while the written reason sat directly beneath
 * it. The identifier was never the useful half.
 *
 * Resolving it here also reports something nothing else does. A human blocker clears when the human
 * acts and they know they acted; a TASK blocker clears when a different card changes state, and the
 * blocked card is never told. One had been waiting on finished work for days. The board can see
 * that from the two cards together, so it says so rather than leaving it to be noticed.
 */
export function waitingOnLabel(item: BoardItem, items: BoardItem[]): string | undefined {
	const blocker = item.blockedOn;
	if (!blocker) return undefined;
	if (blocker.kind !== 'task') return `Waiting on ${blocker.target}`;
	const task = items.find((candidate) => candidate.id === blocker.target);
	if (!task) return 'Waiting on a card that no longer exists';
	return task.state === 'done'
		? `${SATISFIED} — “${task.title}” is done`
		: `Waiting on “${task.title}”`;
}
