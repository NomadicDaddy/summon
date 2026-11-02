import type { CliStatus } from './cli-status.ts';

const providers = ['claude', 'codex', 'grok', 'kilo'] as const;
const storageKey = 'summon.hiddenProviders';

/** Unavailable filters must not strand teammates behind a saved hidden preference. */
export function providerFilterState(hidden: boolean, status: CliStatus['status'] | undefined) {
	const disabled = status !== 'available';
	return { disabled, hidden: !disabled && hidden };
}

/** Local roster visibility only; session selection and lifecycle stay independent. */
export function setupProviderFilters(roster: HTMLElement): (statuses?: CliStatus[]) => void {
	const container = document.getElementById('provider-filters');
	if (!container) throw new Error('Missing provider filters');
	const hidden = new Set<string>();
	let availability: CliStatus[] = [];
	const presence = document.getElementById('presence-filters');
	if (!presence) throw new Error('Missing presence filters');
	let mode = 'all';
	try {
		const savedMode = localStorage.getItem('summon.rosterPresence');
		if (savedMode === 'active' || savedMode === 'online' || savedMode === 'offline')
			mode = savedMode;
		const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
		if (Array.isArray(saved))
			for (const provider of providers) if (saved.includes(provider)) hidden.add(provider);
	} catch {
		// Unavailable or malformed storage must not prevent access to teammates.
	}
	const state = (provider: string) =>
		providerFilterState(
			hidden.has(provider),
			availability.find((s) => s.provider === provider)?.status,
		);
	const update = (statuses?: CliStatus[]): void => {
		if (statuses) availability = statuses;
		for (const member of roster.querySelectorAll<HTMLElement>('.member')) {
			const online =
				member.classList.contains('running') || member.classList.contains('elsewhere');
			// A held lock nobody could verify is neither online nor offline: it shows under All only.
			const unverified = member.classList.contains('unknown');
			member.hidden =
				state(member.dataset.provider ?? '').hidden ||
				(mode === 'active' && (!online || member.closest('.rest-row') !== null)) ||
				(mode === 'online' && !online) ||
				(mode === 'offline' && (online || unverified));
		}
		for (const button of presence.querySelectorAll('button'))
			button.setAttribute('aria-pressed', String(button.dataset.presence === mode));
		for (const button of container.querySelectorAll('button')) {
			const provider = button.dataset.provider ?? '';
			const current = state(provider);
			button.disabled = current.disabled;
			button.setAttribute('aria-pressed', String(!current.hidden));
			button.title = current.disabled
				? `${button.getAttribute('aria-label')}: filter unavailable until the CLI check is Found. Check CLIs in Maintenance.`
				: `${current.hidden ? 'Show' : 'Hide'} ${button.getAttribute('aria-label')}`;
		}
	};
	for (const provider of providers) {
		const button = document.createElement('button');
		button.type = 'button';
		button.dataset.provider = provider;
		button.textContent = providerLabels[provider].short;
		button.setAttribute('aria-label', `${providerLabels[provider].name} teammates`);
		button.setAttribute('aria-controls', 'roster');
		button.addEventListener('click', () => {
			if (state(provider).disabled) return;
			if (hidden.has(provider)) hidden.delete(provider);
			else hidden.add(provider);
			update();
			try {
				localStorage.setItem(storageKey, JSON.stringify([...hidden]));
			} catch {
				// Keep filtering usable for this window even when preferences cannot be saved.
			}
		});
		container.append(button);
	}
	for (const value of ['all', 'active', 'online', 'offline']) {
		const button = document.createElement('button');
		button.type = 'button';
		button.dataset.presence = value;
		button.textContent = value.slice(0, 1).toUpperCase() + value.slice(1);
		button.setAttribute('aria-controls', 'roster');
		button.title =
			value === 'offline'
				? 'Show stopped and hibernated teammates'
				: value === 'online'
					? 'Show teammates running here or elsewhere'
					: value === 'active'
						? 'Show online teammates who are not resting'
						: 'Show all session states';
		button.addEventListener('click', () => {
			mode = value;
			update();
			try {
				localStorage.setItem('summon.rosterPresence', mode);
			} catch {
				// Keep this window usable when preferences cannot be saved.
			}
		});
		presence.append(button);
	}
	update();
	return update;
}
import { providerLabels } from './provider-labels.ts';
