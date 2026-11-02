import type { OperatorIdentity } from '../operator-identity-model.ts';
import type { TeamSnapshot } from './types.ts';

import { setupDiaryLinks } from './diary-links.ts';
import { row, updateDiaryOperator } from './diary-row.ts';
import { setupDiarySeen } from './diary-seen.ts';
import { prependPanelHeading } from './panel-heading.ts';
import { updateWorkPanelDivider } from './work-panel.ts';

export function setupDiary(showError: (error: unknown) => void): (snapshot: TeamSnapshot) => void {
	const panel = document.getElementById('diary');
	const toggle = document.getElementById('diary-toggle');
	const board = document.getElementById('board-toggle');
	if (!panel || !toggle || !board) return () => undefined;
	let operator: OperatorIdentity | undefined;
	let operatorKey = JSON.stringify(operator);
	const search = document.createElement('input');
	search.type = 'search';
	search.id = 'diary-search';
	search.placeholder = 'Search authors or messages';
	search.setAttribute('aria-label', 'Search authors or messages');
	search.maxLength = 300;
	/**
	 * Whether a search narrows the list or only marks it.
	 *
	 * Phillip asked at #4754 whether both filtering and highlighting should be defaults with a
	 * toggle each. Highlighting has no useful off position - with filtering on, every visible row
	 * matched, so the marks are the only thing saying WHERE, and with no search term there is
	 * nothing to mark either way. Filtering does: off is the whole diary in date order with the hits
	 * marked, which answers "when did this come up" rather than "show me the ones that mention it".
	 * So there is one control, and it is this one (#4760).
	 *
	 * It says which VIEW you are in rather than what pressing it does, because filtering is a state
	 * you are in for a while and the label has to answer "what am I looking at" at a glance.
	 */
	let matchesOnly = true;
	const scope = document.createElement('button');
	scope.type = 'button';
	scope.id = 'diary-scope';
	scope.className = 'diary-scope';
	const status = document.createElement('p');
	status.className = 'diary-status';
	status.setAttribute('role', 'status');
	const list = document.createElement('ol');
	const older = document.createElement('button');
	older.textContent = 'Older entries';
	older.hidden = true;
	panel.append(search, scope, status, list, older);
	prependPanelHeading(panel, 'Diary');
	setupDiaryLinks(list);
	const lastSeen = setupDiarySeen(panel, list);
	let open = false;
	let busy = false;
	let next: string | null = null;
	let signature: string | undefined;
	let revision = 0;
	const seen = new Set<string>();
	const load = async (before?: string): Promise<void> => {
		if (busy) return;
		busy = true;
		const request = revision;
		const query = search.value.trim();
		// What is asked of the backend, as against what is marked on screen. With the filter off
		// these differ: everything is requested and the term is still marked wherever it lands.
		const filterBy = matchesOnly ? query : '';
		older.disabled = true;
		try {
			let page = await window.team.diaryRead(before, filterBy);
			if (request !== revision) return;
			if (before === undefined) {
				const current = page.entries.map((entry) => entry.id).join(',');
				if (current === signature) return;
				const added = [...page.entries];
				while (
					seen.size &&
					page.next &&
					page.entries.every((entry) => !seen.has(entry.id))
				) {
					page = await window.team.diaryRead(page.next, filterBy);
					if (request !== revision) return;
					added.push(...page.entries);
				}
				signature = current;
				// Prepend new entries; leave the operator's older pages and focused links intact.
				const fresh = added.filter((entry) => !seen.has(entry.id));
				for (const entry of fresh) {
					// Only entry rows determine order; Last Seen has no recording timestamp.
					const position = [...list.children].find(
						(node) =>
							node instanceof HTMLElement &&
							node.dataset.diaryAt !== undefined &&
							node.dataset.diaryAt < entry.at,
					);
					list.insertBefore(row(entry, query, operator), position ?? null);
				}
				fresh.forEach((entry) => seen.add(entry.id));
				if (next === null && seen.size <= 100) next = page.next;
			} else {
				for (const entry of page.entries) {
					if (!seen.has(entry.id)) list.append(row(entry, query, operator));
					seen.add(entry.id);
				}
				next = page.next;
			}
			// "Newest recorded": the order is when each entry was written down. A backfilled entry
			// shows the earlier date it is about, and without the word that date near the top of the
			// list would read as the list being out of order.
			status.textContent = !query
				? seen.size
					? 'Newest recorded first · Team work and notable handoffs'
					: 'No diary entries yet.'
				: matchesOnly
					? seen.size
						? 'Matching entries · Newest recorded first'
						: 'No entries match your search.'
					: 'All entries · Newest recorded first · matches marked';
			older.hidden = next === null;
			lastSeen.refresh();
		} catch (error: unknown) {
			if (request === revision) showError(error);
		} finally {
			if (request === revision) {
				busy = false;
				older.disabled = false;
			}
		}
	};
	const close = (): void => {
		lastSeen.close();
		open = false;
		panel.hidden = true;
		updateWorkPanelDivider();
		toggle.setAttribute('aria-pressed', 'false');
	};
	toggle.addEventListener('click', () => {
		if (open) {
			close();
			return;
		}
		if (board.getAttribute('aria-pressed') === 'true') board.click();
		open = true;
		panel.hidden = false;
		lastSeen.open();
		updateWorkPanelDivider();
		toggle.setAttribute('aria-pressed', 'true');
		// Reopen reloads rather than resumes. The poll only ever adds unseen ids, so an entry whose
		// date or text was repaired under the same id, or one removed on approval, stayed on screen
		// as it was first drawn. Closing and opening is the operator's "refresh", and it now is one:
		// the older pages and any focused link go, which a reopen already implies.
		restart();
	});
	board.addEventListener('click', () => {
		if (board.getAttribute('aria-pressed') === 'true') close();
	});
	older.addEventListener('click', () => {
		if (next !== null) void load(next);
	});
	const restart = (): void => {
		revision++;
		busy = false;
		signature = undefined;
		next = null;
		seen.clear();
		list.replaceChildren();
		older.hidden = true;
		lastSeen.filter(search.value.trim().length > 0);
		void load();
	};
	const paintScope = (): void => {
		// The control is meaningless without a term, so it is not there without one.
		scope.hidden = search.value.trim().length === 0;
		scope.textContent = matchesOnly ? 'Matches only' : 'All entries';
		scope.setAttribute('aria-pressed', String(matchesOnly));
		scope.title = matchesOnly
			? 'Showing only entries that match. Press to show every entry with matches marked.'
			: 'Showing every entry, with matches marked. Press to show only the ones that match.';
	};
	paintScope();
	scope.addEventListener('click', () => {
		matchesOnly = !matchesOnly;
		paintScope();
		restart();
	});
	search.addEventListener('input', () => {
		paintScope();
		revision++;
		busy = false;
		signature = undefined;
		next = null;
		seen.clear();
		list.replaceChildren();
		older.hidden = true;
		lastSeen.filter(search.value.trim().length > 0);
		void load();
	});
	window.setInterval(() => {
		if (open) void load();
	}, 5000);
	return (snapshot) => {
		const identity = snapshot.operator;
		const key = JSON.stringify(identity);
		if (key === operatorKey) return;
		operator = identity;
		operatorKey = key;
		for (const who of list.querySelectorAll<HTMLElement>('.diary-who'))
			updateDiaryOperator(who, operator);
	};
}
