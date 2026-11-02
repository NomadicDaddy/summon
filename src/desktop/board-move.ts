import type { BoardItem, BoardSnapshot } from '../board-model.ts';
import type { BoardMove } from './types.ts';

import { readBoard, updateBoardItem } from '../board.ts';
import { CommunicationRefreshError } from '../communication-gate.ts';
import { sendCliMessage } from '../local-room-access.ts';
import { operatorOnly } from '../mail-identity.ts';
import { slugFor } from '../store.ts';

// Named moves keep arbitrary fields out of the renderer's write surface.
const moves: Record<BoardMove, Record<string, unknown>> = {
	approve: { state: 'done' },
	archive: { archived: true },
	backlog: { state: 'backlog' },
	// No blocker field: the store refuses Ready while a blocker stands, which is the rule wanted.
	promote: { state: 'ready' },
	unblock: { blockedOn: null, state: 'ready' },
};

function isMove(value: unknown): value is BoardMove {
	return typeof value === 'string' && Object.hasOwn(moves, value);
}

function checked(revision: unknown): number {
	if (typeof revision !== 'number' || !Number.isSafeInteger(revision))
		throw new Error('Invalid item revision.');
	return revision;
}

/**
 * The card as it stands, for the rules a button already implies. The store still decides whether
 * the revision is current when it saves; a card that moved on in between is refused there.
 */
async function standing(id: string, revision: number): Promise<BoardItem> {
	const item = (await readBoard()).items.find((candidate) => candidate.id === id);
	if (!item) throw new Error('Board item not found.');
	if (item.revision !== revision) throw new Error('Board item changed; reload before saving.');
	return item;
}

async function save(id: string, revision: number, fields: Record<string, unknown>) {
	return updateBoardItem(id, revision, fields).catch((error: unknown) => {
		if (error instanceof CommunicationRefreshError)
			throw new Error(`Board change was not saved. ${error.message}`);
		throw error;
	});
}

/** Tell teammates in the room. A saved decision is never rolled back when the notice fails. */
async function tell(item: BoardItem, to: string[], decision: string): Promise<void> {
	const names = to.filter((name) => name !== '');
	if (names.length === 0) return;
	// Titles are data, not additional wake targets. Keep only the explicit mentions.
	const title = item.title.replace(/@/g, '');
	const mentions = names.map((name) => `@${name}`).join(' ');
	try {
		// CLI attribution directs the wake without impersonating a human instruction. The
		// operator decision itself remains recorded in board history at this item revision.
		await sendCliMessage(`${mentions} ${decision}: ${title} (board ${item.id})`);
	} catch {
		// Do not roll back a saved decision or silently retry: delivery may be uncertain.
		throw new Error(
			`Board decision saved (${item.state}): ${title}. Chat notification failed; ` +
				`check the room and tell ${names.join(' and ')} if missing. Do not repeat the board move.`,
		);
	}
}

export async function moveBoard(
	id: unknown,
	revision: unknown,
	move: unknown,
): Promise<BoardSnapshot> {
	operatorOnly();
	if (typeof id !== 'string' || !isMove(move)) throw new Error('Invalid board move.');
	const at = checked(revision);
	// Move to Ready is for work that has not started. Without this a Doing or Done card could be
	// reset to Ready and its owner told to go ahead.
	if (move === 'promote' && (await standing(id, at)).state !== 'backlog')
		throw new Error('Only a Backlog card can be moved to Ready.');
	const snapshot = await save(id, at, moves[move]);
	const item = snapshot.items.find((candidate) => candidate.id === id);
	if (!item) return snapshot;
	if (move === 'approve') await tell(item, [item.owner], 'accepted completed work');
	else if (move === 'promote' || move === 'unblock') await tell(item, [item.owner], 'go ahead');
	return snapshot;
}

/**
 * The operator gives a card to a registered teammate. The store checks the name and that owner and
 * partner differ. Both teammates are told when the card is already startable or started, so the
 * one who had it stops and the one who has it starts; a Backlog card is not work yet, and its
 * owner hears "go ahead" when it is moved to Ready.
 */
export async function ownBoard(
	id: unknown,
	revision: unknown,
	owner: unknown,
): Promise<BoardSnapshot> {
	operatorOnly();
	if (typeof id !== 'string' || typeof owner !== 'string' || owner.trim() === '')
		throw new Error('Invalid board owner.');
	const at = checked(revision);
	const before = await standing(id, at);
	if (before.state === 'done' || before.archived)
		throw new Error('A Done or archived card keeps its owner.');
	if (slugFor(owner) === before.owner) throw new Error('That teammate already owns this card.');
	const snapshot = await save(id, at, { owner });
	const item = snapshot.items.find((candidate) => candidate.id === id);
	if (!item) return snapshot;
	if (item.state !== 'backlog') {
		const was = before.owner ? `, no longer ${before.owner}'s` : '';
		await tell(item, [item.owner, before.owner], `this card is now ${item.owner}'s${was}`);
	}
	return snapshot;
}
