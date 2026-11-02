import type { BoardSnapshot } from './board-model.ts';

import {
	addBoardComment,
	boardHistory,
	boardWork,
	createBoardItem,
	readBoard,
	updateBoardItem,
} from './board.ts';

function mutationResult(board: BoardSnapshot, id?: string) {
	const item = id ? board.items.find((candidate) => candidate.id === id) : board.items.at(-1);
	if (!item) throw new Error('Changed Board item missing from mutation result.');
	return { revision: board.revision, item };
}

export async function boardCommand(args: string[]): Promise<void> {
	const [action, id, revision, body] = args;
	let result: unknown;
	if ((action === 'list' && args.length === 1) || args.length === 0) result = await readBoard();
	// A launched session asks about itself and passes no name; the operator names whose work to see.
	else if (action === 'mine' && args.length <= 2) result = await boardWork(id);
	else if (action === 'history' && id && args.length === 2) result = await boardHistory(id);
	else if (action === 'create' && id && args.length === 2)
		result = mutationResult(await createBoardItem(JSON.parse(id) as unknown));
	else if (action === 'update' && id && revision && body && args.length === 4)
		result = mutationResult(
			await updateBoardItem(id, Number(revision), JSON.parse(body) as unknown),
			id,
		);
	// A comment takes no revision: appends do not conflict, so there is nothing to be stale against.
	else if (action === 'comment' && id && revision && args.length === 3)
		result = mutationResult(await addBoardComment(id, revision), id);
	else
		throw new Error(
			'Usage: summon --board list | mine [name] | create <json> | update <id> <revision> <json> | comment <id> <text> | history <id>',
		);
	console.log(JSON.stringify(result));
}
