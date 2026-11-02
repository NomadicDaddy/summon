import type { BoardSearchState } from './board-search-view.ts';

/** The Board's search controls: one row that outlives every redraw of the lanes beneath it. */
export interface BoardSearch {
	/** Sets the status line; an empty string hides it. */
	report: (status: string) => void;
	root: HTMLElement;
	state: () => BoardSearchState;
}

/** Long enough that a typed word is one redraw, short enough to feel immediate. */
const TYPING_PAUSE_MS = 120;

function toggle(id: string): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.id = id;
	button.className = 'board-view-toggle';
	return button;
}

/**
 * Builds the search row (card 150ea87c). It takes the Diary's treatment, so the two panels answer
 * a search the same way: a field, a control that names the VIEW you are in rather than what
 * pressing it does (#4760), and a status line.
 *
 * The Board needs a second control the Diary does not. Archived cards are never on the Board, and
 * a search is the one place they should be reachable, so a term shows the archived cards that
 * match and this control says whether it is doing so. Neither control exists without a term:
 * with nothing searched for there is no view to choose between.
 */
export function setupBoardSearch(onChange: () => void): BoardSearch {
	const root = document.createElement('div');
	root.className = 'board-toolbar';
	const search = document.createElement('input');
	search.type = 'search';
	search.id = 'board-search';
	search.placeholder = 'Search titles, text or owners';
	search.setAttribute('aria-label', 'Search titles, text or owners');
	search.maxLength = 300;
	const scope = toggle('board-scope');
	const archived = toggle('board-archived');
	const status = document.createElement('p');
	status.className = 'board-status';
	status.setAttribute('role', 'status');
	status.hidden = true;
	root.append(search, scope, archived, status);

	let matchesOnly = true;
	let withArchived = true;
	const paint = (): void => {
		const searching = search.value.trim().length > 0;
		scope.hidden = !searching;
		archived.hidden = !searching;
		scope.textContent = matchesOnly ? 'Matches only' : 'All cards';
		scope.setAttribute('aria-pressed', String(matchesOnly));
		scope.title = matchesOnly
			? 'Showing only cards that match. Press to show every card with matches marked.'
			: 'Showing every card, with matches marked. Press to show only the ones that match.';
		archived.textContent = withArchived ? 'With archived' : 'Live only';
		archived.setAttribute('aria-pressed', String(withArchived));
		archived.title = withArchived
			? 'Archived cards that match are shown, tagged Archived. Press to search live cards only.'
			: 'Searching live cards only. Press to include archived cards that match.';
	};
	paint();
	scope.addEventListener('click', () => {
		matchesOnly = !matchesOnly;
		paint();
		onChange();
	});
	archived.addEventListener('click', () => {
		withArchived = !withArchived;
		paint();
		onChange();
	});
	let pending: ReturnType<typeof setTimeout> | undefined;
	search.addEventListener('input', () => {
		paint();
		clearTimeout(pending);
		pending = setTimeout(onChange, TYPING_PAUSE_MS);
	});
	return {
		report: (text) => {
			status.textContent = text;
			status.hidden = text === '';
		},
		root,
		state: () => ({ matchesOnly, query: search.value, withArchived }),
	};
}
