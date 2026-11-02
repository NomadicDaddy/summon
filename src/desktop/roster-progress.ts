import type { TeamAgent } from './types.ts';

import { furthestBehind, notReporting, roomLagText } from './room-lag.ts';

/**
 * The room-progress line above the roster.
 *
 * Deliberately its own element rather than another row inside `#roster-coverage`. Two reasons, and
 * both are about not inheriting a neighbour's rules: the cover block returns early when no teammate
 * claims a domain, which has nothing to do with whether somebody is behind the room; and the
 * Show domain coverage setting hides that block wholesale, which must not take this with it.
 *
 * NO ROW TOOLTIP, and that is a decision rather than an omission. The obvious second home for this
 * is `button.title` on the teammate's roster row - except `markFaultedRow` already owns that
 * property for fault detail, which is louder and more time-critical. Two owners for one property is
 * how a control comes to show the wrong thing depending on which code ran last, so this stays in
 * one place and the fault keeps the title to itself.
 */
export function setupRosterProgress(): (agents: readonly TeamAgent[]) => void {
	const root = document.getElementById('roster-progress');
	if (root === null) return () => undefined;
	return (agents) => {
		const lag = furthestBehind(agents);
		if (lag === undefined) {
			// Nobody behind, or nobody measurable. An empty block says more by saying nothing.
			root.replaceChildren();
			return;
		}
		const rows: HTMLElement[] = [];
		const row = document.createElement('p');
		row.className = 'progress-lag';
		const label = document.createElement('strong');
		label.textContent = 'Furthest behind:';
		row.append(label, document.createTextNode(` ${lag.name}, ${roomLagText(lag)}`));
		rows.push(row);
		/*
		 * The bound on the claim above, and it belongs on screen rather than only in a comment.
		 * "Furthest behind: Morgan" reads as a fact about the whole roster; it is a fact about the
		 * teammates whose progress could be read. A teammate with no metadata could be further
		 * behind than the one named, and nothing here would know. Said in a second line rather than
		 * folded into the first, because the first has to stay short enough not to wrap to three
		 * lines in a sidebar this narrow.
		 */
		const silent = notReporting(agents);
		if (silent > 0) {
			const note = document.createElement('p');
			note.className = 'progress-unavailable';
			note.textContent =
				silent === 1
					? '1 teammate is not reporting progress, and could be further behind.'
					: `${String(silent)} teammates are not reporting progress, and could be further behind.`;
			rows.push(note);
		}
		root.replaceChildren(...rows);
	};
}
