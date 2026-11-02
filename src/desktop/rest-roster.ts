import type { TeamAgent } from './types.ts';

/**
 * Whether the row offers its Zzz rest-stop. Not while the provider's turn record says busy or can't
 * be read as idle: the button stops without the ordinary Stop question, and its main-process path
 * does not yet read the provider turn (Morgan's rest-stop finding, 2026-10-23). Hiding it is the
 * window declining to offer a stop it can't stand behind, not the guard; the label says Busy then.
 */
export function offersRestStop(agent: TeamAgent): boolean {
	return (
		!!agent.restConfirmation && agent.status === 'running' && agent.providerTurn === undefined
	);
}

// The row's word, Resting, comes from memberStateLabel, so the header and statusbar say it too.
export function restRosterRow(
	agent: TeamAgent,
	member: HTMLButtonElement,
	stop: (slug: string, confirmation: string) => void,
): HTMLElement {
	if (!offersRestStop(agent)) return member;
	const confirmation = agent.restConfirmation;
	if (!confirmation) return member;
	const row = document.createElement('div');
	row.className = 'rest-row';
	member.querySelector('.dot')?.setAttribute('aria-hidden', 'true');
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'rest-stop';
	button.dataset.restSlug = agent.slug;
	const pill = document.createElement('span');
	pill.textContent = 'Zzz';
	button.append(pill);
	button.title = `${agent.name} confirmed ready to rest. Stop Session.`;
	button.setAttribute('aria-label', button.title);
	button.addEventListener('click', () => stop(agent.slug, confirmation));
	row.append(member, button);
	return row;
}

export function restoreRestFocus(roster: HTMLElement, name: string | undefined): void {
	if (!name) return;
	for (const button of roster.querySelectorAll<HTMLButtonElement>('.rest-stop'))
		if (button.dataset.restSlug === name) button.focus({ preventScroll: true });
}
