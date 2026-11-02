import type { BoardItem, BoardSnapshot } from '../board-model.ts';
import type { BoardActions } from './board-card.ts';
import type { BoardSelection } from './board-search-view.ts';

import { boardStates } from '../board-states.ts';
import { laneHelp, showLaneHelp } from './board-action-help.ts';
import { buildCard } from './board-card.ts';
import { byOldestFirst, waitingOnLabel } from './board-ordering.ts';
import { blockerName } from './board-search-match.ts';
import { boardSearchStatus, selectBoardCards } from './board-search-view.ts';
import { setupBoardSearch } from './board-search.ts';
import { replaceBoardLanes, revealBoardCard } from './board-view-state.ts';
import { prependPanelHeading } from './panel-heading.ts';
import { updateWorkPanelDivider } from './work-panel.ts';

/**
 * Lane order. `backlog` first and `done` last reads left-to-right as progress, which is the one
 * thing a lane layout says for free. `archived` is deliberately absent: it is a flag orthogonal
 * to state, so an archived card keeps the state it finished in and simply stops being shown.
 */
const LANES = boardStates;

/**
 * A lane names a state, which says what the card is but not who is expected to act on it.
 *
 * Review is the one lane where that actor is the operator rather than the card's owner - `Approve`
 * is rendered only here, and it both completes the card and messages the owner. The label alone
 * left that ambiguous enough to be asked outright: whether "review" meant someone else was
 * reviewing, or that it was waiting on them. `laneHelp` had the answer and you had to click to get
 * it, so it is on the heading now.
 */
const laneActor: Partial<Record<BoardItem['state'], string>> = {
	review: 'waiting on you',
};

/**
 * Lanes are lumpy and that is not a transient condition. Measured on the first five real cards:
 * every one sat in `blocked`, and between two domains that lane already held thirteen while
 * `ready` held none. Equal-width columns would spend five sixths of the panel on emptiness, so
 * an empty lane collapses to its heading and the rest share what is left.
 */
function laneIsEmpty(items: BoardItem[]): boolean {
	return items.length === 0;
}

function buildLane(
	state: BoardItem['state'],
	items: BoardItem[],
	actions: BoardActions,
	all: BoardItem[],
	query: string,
	selection: BoardSelection,
): HTMLElement {
	const lane = document.createElement('section');
	lane.className = 'board-lane';
	lane.dataset['state'] = state;
	if (laneIsEmpty(items)) lane.classList.add('is-empty');

	const heading = document.createElement('h3');
	const help = document.createElement('button');
	help.type = 'button';
	help.className = 'board-lane-help';
	help.textContent = `${state} ⓘ`;
	help.title = laneHelp[state];
	help.setAttribute('aria-label', `${state}: explain lane and actions`);
	help.addEventListener('click', () => showLaneHelp(state));
	heading.append(help);
	const count = document.createElement('span');
	count.className = 'board-lane-count';
	count.textContent = String(items.length);
	heading.append(count);
	const actor = laneActor[state];
	if (actor !== undefined && items.length > 0) {
		const note = document.createElement('span');
		note.className = 'board-lane-actor';
		note.textContent = actor;
		heading.append(note);
	}
	lane.append(heading);

	for (const item of [...items].sort(byOldestFirst)) {
		lane.append(
			buildCard(item, actions, waitingOnLabel(item, all), {
				blocker: blockerName(item, all),
				match: selection.matches.get(item.id) ?? null,
				query,
			}),
		);
	}
	return lane;
}

/**
 * Renders the board into `#board`. Returns an updater in the shape the other panels use, so the
 * caller re-renders on a revision change rather than this module polling for one.
 *
 * Actions remain revision-bound while refreshes retain the operator's reading position. The search
 * row is built once and never redrawn; a change in it redraws the lanes from the snapshot already
 * held, so searching never waits on a read and never asks the backend for anything.
 */
function setupBoard(
	actions: BoardActions,
): (snapshot: BoardSnapshot, selectedOwner: null | string, shown?: null | string) => void {
	const found = document.getElementById('board');
	if (found === null) return () => undefined;
	const root: HTMLElement = found;
	let held: null | { owner: null | string; shown: null | string; snapshot: BoardSnapshot } = null;
	let drawn = '';
	const search = setupBoardSearch(() => {
		draw();
	});
	root.append(search.root);
	function draw(): void {
		if (held === null) return;
		const { owner, shown, snapshot } = held;
		const state = search.state();
		const key = JSON.stringify([snapshot.revision, owner, state, shown]);
		if (key === drawn) return;
		drawn = key;
		const selection = selectBoardCards(snapshot.items, owner, state, shown);
		const lanes = LANES.map((lane) =>
			buildLane(
				lane,
				selection.visible.filter((item) => item.state === lane),
				actions,
				// Unfiltered on purpose: a task blocker routinely names another owner's card, and
				// resolving it against the visible subset would fail exactly when it matters.
				snapshot.items,
				state.query,
				selection,
			),
		);
		replaceBoardLanes(root, lanes);
		search.report(boardSearchStatus(state, selection));
	}
	return (snapshot, selectedOwner, shown = null) => {
		held = { owner: selectedOwner, shown, snapshot };
		draw();
	};
}

/**
 * Wires the toggle and returns a redraw the caller invokes when the board changes or the roster
 * selection moves. `read` and `actions` are the only things here that need the bridge, so the
 * caller supplies both; every card the Board draws offers the moves its state allows.
 */
export function setupBoardToggle(
	read: () => Promise<BoardSnapshot | null>,
	selectedOwner: () => null | string,
	actions: BoardActions,
): () => void {
	const panel = document.getElementById('board');
	const toggle = document.getElementById('board-toggle');
	if (panel === null || toggle === null) return () => undefined;
	const render = setupBoard(actions);
	let open = false;
	// The card Jump asked for, and the teammate selected when it did. It stays shown through
	// refreshes and is let go when the selection moves or the Board closes.
	let shown: null | { id: string; owner: null | string } = null;

	prependPanelHeading(panel, 'Team Board');

	const draw = (reveal = false): void => {
		panel.hidden = !open;
		updateWorkPanelDivider();
		toggle.setAttribute('aria-pressed', String(open));
		if (!open || shown?.owner !== selectedOwner()) shown = null;
		if (!open) return;
		void read().then((snapshot) => {
			if (snapshot === null) return;
			render(snapshot, selectedOwner(), shown?.id ?? null);
			if (reveal && shown) revealBoardCard(panel, shown.id);
		});
	};
	// Jump asks from outside the panel, so it asks with an event rather than an import: the Board
	// then owns how a card is brought into view, and Jump owns only what was typed.
	panel.addEventListener('board-jump', (event) => {
		const id = (event as CustomEvent<unknown>).detail;
		if (typeof id !== 'string') return;
		open = true;
		shown = { id, owner: selectedOwner() };
		draw(true);
	});
	toggle.addEventListener('click', () => {
		open = !open;
		// Returning focus to the button on close matches the room panel, so a keyboard user is
		// not dropped at the top of the document after dismissing it.
		if (!open) toggle.focus();
		draw();
	});
	return () => {
		draw();
	};
}
