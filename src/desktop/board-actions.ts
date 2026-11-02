import type { BoardActions } from './board-card.ts';
import type { BoardMove } from './types.ts';

/**
 * The Board's operator moves, bound to the bridge. `run` is the window's error-reporting wrapper
 * and `redraw` repaints the Board; a notification error can follow a saved move, so the persisted
 * lane is shown whether the call resolves or rejects.
 */
export function boardActions(
	run: (work: () => Promise<void>) => Promise<boolean>,
	redraw: () => void,
	teammates: BoardActions['teammates'],
): BoardActions {
	const write = async (work: () => Promise<unknown>): Promise<void> => {
		await run(async () => {
			try {
				await work();
			} finally {
				redraw();
			}
		});
	};
	const move = (id: string, revision: number, verb: BoardMove): Promise<void> =>
		write(() => window.team.boardMove(id, revision, verb));
	return {
		approve: (id, revision) => move(id, revision, 'approve'),
		archive: (id, revision) => move(id, revision, 'archive'),
		changeOwner: (id, revision, owner) =>
			write(() => window.team.boardOwner(id, revision, owner)),
		promote: (id, revision) => move(id, revision, 'promote'),
		returnToBacklog: (id, revision) => move(id, revision, 'backlog'),
		teammates,
		unblock: (id, revision) => move(id, revision, 'unblock'),
	};
}
