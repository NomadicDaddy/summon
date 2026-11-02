/**
 * The two tabs of the maintenance dialog (card 32f030f9, design call #6178).
 *
 * Person is one teammate's record and Team is what applies to everyone. They were one scrolling
 * column, with the team-wide switches sitting in whichever teammate's dialog happened to be open
 * and vanishing altogether while adding somebody. Two tabs put each where it belongs without
 * folding anything away: Phillip's constraint was no collapsing to save space.
 *
 * A real tablist, so it needs nothing explained: arrows move between tabs and select as they go,
 * Home and End go to the ends, and Tab leaves the row for the panel. Only the selected tab is in
 * the Tab order.
 */
export type MaintenanceTab = 'person' | 'team';

const order: readonly MaintenanceTab[] = ['person', 'team'];

/** The tab a key moves to from `current`, or undefined when the key is not one the row handles. */
export function tabForKey(current: MaintenanceTab, key: string): MaintenanceTab | undefined {
	const at = order.indexOf(current);
	const last = order.length - 1;
	switch (key) {
		case 'ArrowLeft':
			return order[at === 0 ? last : at - 1];
		case 'ArrowRight':
			return order[at === last ? 0 : at + 1];
		case 'End':
			return order[last];
		case 'Home':
			return order[0];
		default:
			return undefined;
	}
}

/**
 * Remembers which control in the dialog has focus, and returns a function that gives it back.
 *
 * A control that saves on change is disabled while its save is in flight, and a disabled control
 * cannot hold focus: the browser drops it to the page. For a mouse that is invisible. For a
 * keyboard it loses the reader's place in the dialog after every switch they flip, and a second
 * press of Space goes nowhere. Focus is handed back only if nothing else has taken it meanwhile.
 * @param dialog The dialog whose controls are about to be disabled.
 * @returns Call once the controls are enabled again.
 */
export function keepFocus(dialog: HTMLElement): () => void {
	const held = document.activeElement;
	return () => {
		const lost = document.activeElement === document.body || document.activeElement === dialog;
		if (lost && held instanceof HTMLElement && dialog.contains(held)) held.focus();
	};
}

/**
 * Wires the tab row. `show` selects a tab without moving focus, for the dialog's own openers; a
 * key press in the row selects and moves focus with it, which is what a tablist promises.
 * @param get The dialog's element lookup.
 * @param shown Called after every change, so the dialog can show what belongs to that tab only.
 */
export function setupMaintenanceTabs(
	get: (id: string) => HTMLElement,
	shown: (tab: MaintenanceTab) => void,
): { current: () => MaintenanceTab; show: (tab: MaintenanceTab) => void } {
	let current: MaintenanceTab = 'person';
	const show = (tab: MaintenanceTab): void => {
		current = tab;
		for (const name of order) {
			const selected = name === tab;
			const button = get(`maint-tab-${name}`);
			button.setAttribute('aria-selected', String(selected));
			button.tabIndex = selected ? 0 : -1;
			get(`maint-panel-${name}`).hidden = !selected;
		}
		// Each tab starts at its top: the two panels share one scroll box.
		get('maint-panel-person').parentElement?.scrollTo({ top: 0 });
		shown(tab);
	};
	for (const name of order) {
		const button = get(`maint-tab-${name}`);
		button.addEventListener('click', () => show(name));
		button.addEventListener('keydown', (event) => {
			const next = tabForKey(name, event.key);
			if (!next) return;
			event.preventDefault();
			show(next);
			get(`maint-tab-${next}`).focus();
		});
	}
	return { current: () => current, show };
}
