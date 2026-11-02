/**
 * Ctrl+1 to Ctrl+9 select a teammate by the ordinal drawn beside its avatar (card 008508fe;
 * ordinals Phillip #12538, keys follow them #12557).
 *
 * The count is the one on screen: rows hidden by the provider or Online/Offline filter are
 * skipped, and so is the PM, who is 0 and pinned first, so Ctrl+3 is always the row showing 3.
 * Only rows 1 to 9 have a key, and the numbers stop there too: a tenth row onward shows no
 * ordinal, because a drawn number with no key promises a shortcut that does not exist (Phillip
 * #15921, replacing the earlier "numbers go on without a key").
 *
 * Selecting is done by pressing the row, so this holds no copy of how selection works: a running
 * teammate's terminal takes focus exactly as it does on a click.
 *
 * Ctrl+0 selects the PM (Phillip #12349), whatever the PM's state and whatever the filters show:
 * the first PM in the roster, even while its row is hidden (#12350, Phillip viewing Active while
 * the PM rests). Like the other keys it only selects: it starts, wakes or stops nobody. With no
 * PM on the team it does nothing.
 */

/** The parts of a key press this shortcut reads. */
export interface MemberKeyPress {
	altKey: boolean;
	code: string;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}

/**
 * The sidebar position a key press asks for, counted from zero, or undefined when the press is
 * not this shortcut. Ctrl with a top-row digit and nothing else: Shift, Alt and the number pad
 * are left to whatever else wants them.
 */
export function memberKeyIndex(press: MemberKeyPress): number | undefined {
	if (!press.ctrlKey || press.altKey || press.shiftKey || press.metaKey) return undefined;
	const digit = /^Digit([1-9])$/.exec(press.code)?.[1];
	return digit === undefined ? undefined : Number(digit) - 1;
}

/** Whether a key press is Ctrl+0, the PM's key: Ctrl with the top-row 0 and nothing else. */
export function pmKey(press: MemberKeyPress): boolean {
	return (
		press.ctrlKey &&
		!press.altKey &&
		!press.shiftKey &&
		!press.metaKey &&
		press.code === 'Digit0'
	);
}

/** How many teammates have a key. */
export const MEMBER_KEYS = 9;

const allRows = (): HTMLElement[] => [
	...document.querySelectorAll<HTMLElement>('#roster .member[data-slug]'),
];

/** What the choice of row needs to know about each roster row, in roster order. */
export interface RosterRowFacts {
	pm: boolean;
	visible: boolean;
}

/**
 * The small number drawn beside each avatar (Phillip #12538, mockup accepted #12549), in roster
 * order: the first PM is 0 wherever its row sits, and the other visible rows count 1, 2, 3 on
 * screen. A hidden row has none and uses up no number, so the count is always what the operator
 * sees. These are also the keys: Ctrl+N selects the row showing N (#12557), so the count stops
 * at MEMBER_KEYS and later visible rows have none (#15921).
 */
export function rowOrdinals(rows: readonly RosterRowFacts[]): (number | undefined)[] {
	const pm = rows.findIndex((row) => row.pm);
	let seen = 0;
	return rows.map((row, index) => {
		if (index === pm) return 0;
		if (!row.visible) return undefined;
		seen += 1;
		return seen <= MEMBER_KEYS ? seen : undefined;
	});
}

/**
 * Which roster row a key press selects, as an index into all rows, or undefined when nobody is
 * there: the row whose ordinal is the digit pressed. Ctrl+0 is the first PM, visible or hidden;
 * Ctrl+1 to Ctrl+9 count the visible rows after it.
 */
export function targetRowIndex(
	rows: readonly RosterRowFacts[],
	press: MemberKeyPress,
): number | undefined {
	const position = memberKeyIndex(press);
	const wanted = pmKey(press) ? 0 : position === undefined ? undefined : position + 1;
	if (wanted === undefined) return undefined;
	const index = rowOrdinals(rows).indexOf(wanted);
	return index < 0 ? undefined : index;
}

const facts = (row: HTMLElement): RosterRowFacts => ({
	pm: row.dataset['role'] === 'pm',
	visible: row.closest('[hidden]') === null,
});

/** The row a key press selects, or undefined when nobody is there. */
function targetRow(press: MemberKeyPress): HTMLElement | undefined {
	const rows = allRows();
	const index = targetRowIndex(rows.map(facts), press);
	return index === undefined ? undefined : rows[index];
}

/**
 * Puts the row's ordinal beside its avatar, or takes it away when the row has none. Decorative:
 * the row already announces its keys, so assistive technology is not told the number twice.
 */
function drawOrdinal(row: HTMLElement, ordinal: number | undefined): void {
	const identity = row.querySelector('.member-identity');
	const current = identity?.querySelector(':scope > .member-ordinal') ?? null;
	if (identity === null || ordinal === undefined) {
		current?.remove();
		return;
	}
	const text = String(ordinal);
	if (current?.textContent === text) return;
	if (current !== null) {
		current.textContent = text;
		return;
	}
	const mark = document.createElement('span');
	mark.className = 'member-ordinal';
	mark.setAttribute('aria-hidden', 'true');
	mark.textContent = text;
	identity.prepend(mark);
}

/**
 * Takes the nine position keys and Ctrl+0, and keeps each visible row's keys announced and each
 * row's ordinal drawn. Called once, with the rest of the window's shortcuts.
 */
export function setupMemberKeys(): void {
	const roster = document.getElementById('roster');
	if (roster === null) return;
	// The roster rebuilds its rows on every update and the filters hide rows in place, so the
	// announced key and the drawn ordinal are rewritten whenever either happens. Each is written
	// only when it differs, so the observer's own writes settle after one pass.
	const label = (): void => {
		const rows = allRows();
		const ordinals = rowOrdinals(rows.map(facts));
		rows.forEach((row, index) => {
			const ordinal = ordinals[index];
			drawOrdinal(row, ordinal);
			const wanted = ordinal === undefined ? null : `Control+${String(ordinal)}`;
			if (row.getAttribute('aria-keyshortcuts') === wanted) return;
			if (wanted === null) row.removeAttribute('aria-keyshortcuts');
			else row.setAttribute('aria-keyshortcuts', wanted);
		});
	};
	new MutationObserver(label).observe(roster, {
		attributeFilter: ['hidden'],
		attributes: true,
		childList: true,
		subtree: true,
	});
	label();
	// Counts key presses that selected somebody, so an older press can tell it has been overtaken.
	let request = 0;
	document.addEventListener(
		'keydown',
		(event) => {
			if (memberKeyIndex(event) === undefined && !pmKey(event)) return;
			// Taken before a terminal sees it, and taken even when nobody is at that position or a
			// dialog is open: a key that is the window's sometimes and the CLI's at other times
			// would send a stray control character whenever the roster was short.
			event.preventDefault();
			event.stopImmediatePropagation();
			if (event.repeat || document.querySelector('dialog[open]') !== null) return;
			const row = targetRow(event);
			if (row === undefined) return;
			const slug = row.dataset['slug'];
			row.click();
			// A click with the mouse leaves focus on the row, or in the teammate's terminal when one
			// is running. Pressed from here focus could be left nowhere, or on the row of the
			// teammate just left, so once the selection has landed the new row is given it. Focus
			// anywhere else is not touched: a message being typed stays where it is, and a terminal
			// the selection has already focused keeps it.
			//
			// Two guards, the same two selection-focus.ts has (Roger #8619). A later key press
			// supersedes this one: without that, Ctrl+1 then Ctrl+2 could end with focus on row 1.
			// And focus is given only to the row that is selected: a selection that failed or never
			// landed leaves focus alone rather than pointing at a teammate who is not selected.
			const mine = ++request;
			const settle = (tries: number): void => {
				if (mine !== request) return;
				const current = allRows().find((candidate) => candidate.dataset['slug'] === slug);
				if (current?.getAttribute('aria-current') !== 'true') {
					if (tries > 0) {
						setTimeout(() => {
							settle(tries - 1);
						}, 50);
					}
					return;
				}
				const active = document.activeElement;
				if (active === document.body || active?.closest('#roster') === roster)
					current.focus();
			};
			settle(40);
		},
		true,
	);
}
