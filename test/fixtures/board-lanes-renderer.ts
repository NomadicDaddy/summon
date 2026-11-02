import { at, card, showBoard } from './board-fixture.ts';

/*
 * The Board the 2026-10-18 design sweep clipped at 1440x900: five lanes holding one to three cards
 * and an empty Done, every card carrying its actions. `?room` in the address opens the Room beside
 * it, which is the narrower of the two cases clause 45 names.
 */
const comment = { actor: { id: 'carl', kind: 'agent' as const }, at, body: 'Seen.', revision: 1 };
showBoard([
	card('backlog', 'Quiet card with no hit', 'alice'),
	card('ready', 'Scan the binder manual', 'dave', { comments: [comment] }),
	card('ready', 'Fold the sweep findings', 'erin'),
	card('ready', 'Name the release watcher', 'frank'),
	card('doing', 'Give Board search the Diary treatment', 'morgan'),
	card('doing', 'Measure the rest wake', 'gina'),
	card('doing', 'Restore the winlab guest', 'hugo'),
	card('blocked', 'Rotate the backup exclude list', 'carl', {
		blockedOn: { kind: 'human', reason: 'Needs a yes.', target: 'phillip' },
	}),
	card('blocked', 'Sign the installer', 'hugo', {
		blockedOn: { kind: 'human', reason: 'Needs a certificate.', target: 'phillip' },
	}),
	card('review', 'Header facts parity', 'jimmy'),
]);

/** Each lane's first card, measured against the lane that shows it before anyone scrolls. */
function measure(): void {
	const board = document.getElementById('board');
	const lanes = [...document.querySelectorAll<HTMLElement>('.board-lane')];
	if (!board || lanes.length !== 6) {
		requestAnimationFrame(measure);
		return;
	}
	// How far each lane's first card ends above the lane's bottom border; negative is cut off.
	const clearance = lanes.flatMap((lane) => {
		const actionsRow = lane.querySelector('.board-card .board-card-actions');
		if (!actionsRow) return [];
		const bottom = actionsRow.getBoundingClientRect().bottom;
		const px = Math.round(lane.getBoundingClientRect().bottom - 1 - bottom);
		return [{ lane: lane.dataset['state'] ?? '?', px }];
	});
	const tops = lanes.map((lane) => Math.round(lane.getBoundingClientRect().top));
	const page = document.scrollingElement;
	document.title = `BOARD_LANES ${JSON.stringify({
		boardScrolls: board.scrollHeight > board.clientHeight,
		boardWidth: Math.round(board.getBoundingClientRect().width),
		clipped: clearance
			.filter(({ px }) => px < 0)
			.map(({ lane, px }) => `${lane} by ${String(-px)}px`),
		firstRow: tops.filter((top) => top === tops[0]).length,
		pageFits: page ? page.scrollHeight <= innerHeight : false,
		rows: new Set(tops).size,
		tightest: Math.min(...clearance.map(({ px }) => px)),
	})}`;
}
requestAnimationFrame(measure);
