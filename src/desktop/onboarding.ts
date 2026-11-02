import type { TeamAgent } from './types.ts';

import { unverifiedTitle } from './hibernation-controls.ts';
import { leadWithSetup } from './provider-setup-view.ts';

export function renderWelcome(
	get: (id: string) => HTMLElement,
	selected: TeamAgent | undefined,
	addedSlug: string,
	noTeammates: boolean,
	/** A note from the add's save, such as a skipped Kilo variant check: the dialog has closed. */
	addedNote = '',
): void {
	const empty = get('empty');
	const start = get('start');
	const unavailable = ['elsewhere', 'unknown', 'hibernated'].includes(selected?.status ?? '');
	empty.classList.toggle('is-state', unavailable);
	if (selected?.status === 'unknown') {
		// No clear-lock or repair control: a lock this window cannot verify is not its to remove.
		empty.hidden = false;
		get('empty-title').textContent =
			"Can't start yet: a previous session's lock is still held.";
		get('empty-detail').textContent = unverifiedTitle(selected.presence);
	} else if (selected?.status === 'elsewhere') {
		empty.hidden = false;
		get('empty-title').textContent = 'Already running elsewhere.';
		get('empty-detail').textContent =
			'Use the existing terminal. This window will not start a duplicate or stop that session.';
	} else if (selected?.status === 'hibernated') {
		get('empty-title').textContent = `${selected.name} is hibernated.`;
		get('empty-detail').textContent =
			'Use Unhibernate to allow work and pending messages again.';
	} else if (selected?.slug === addedSlug && selected.status === 'offline') {
		get('empty-title').textContent = `${selected.name} has been added.`;
		get('empty-detail').textContent =
			`${addedNote ? `${addedNote} ` : ''}Nothing is running yet. Start ${selected.name} to open their session in this window.`;
	} else {
		get('empty-title').textContent = selected
			? `Ready for ${selected.name}.`
			: 'Your team, where you need them.';
		// Names the selected teammate, as the title above already does; the button beside it is the
		// toolbar's own start action (L85).
		get('empty-detail').textContent = noTeammates
			? 'Each teammate is a coding-agent CLI with its own working folder and saved conversation. You will need at least one supported CLI installed and signed in.'
			: `Summon ${selected?.name ?? 'a teammate'} here to resume their saved conversation.`;
	}
	const emptyStart = get('empty-start');
	emptyStart.hidden = !noTeammates && (start.hidden || empty.hidden);
	emptyStart.textContent = noTeammates
		? 'Add your first teammate'
		: selected?.slug === addedSlug && selected.status === 'offline'
			? `Start ${selected.name}`
			: start.textContent;
	// What is installed here, and the way to the guide, belong to the first run only: once there is a
	// teammate the same answer lives in Maintenance, and the empty window is about that teammate.
	get('empty-cli').hidden = !noTeammates;
	get('empty-setup').hidden = !noTeammates;
	leadWithSetup(get);
}
