import type { TeamAgent } from '../../src/desktop/types.ts';

import { memberRow } from '../../src/desktop/member-identity.ts';
import { setupProviderFilters } from '../../src/desktop/provider-filters.ts';
import { restRosterRow } from '../../src/desktop/rest-roster.ts';

export function checkPresenceFilters(): number {
	let assertions = 0;
	const assert = (condition: boolean, reason: string) => {
		assertions++;
		if (!condition) throw new Error(reason);
	};
	const roster = document.getElementById('roster');
	const presence = document.getElementById('presence-filters');
	const providers = document.getElementById('provider-filters');
	if (!roster || !presence || !providers) throw new Error('Missing filter fixture');
	const states: Omit<TeamAgent, 'name' | 'cwd'>[] = [
		{ slug: 'working', status: 'running', activity: 'busy', provider: 'claude' },
		{
			slug: 'ready',
			status: 'running',
			activity: 'idle',
			workingOn: 'Ready',
			provider: 'codex',
		},
		{ slug: 'resting', status: 'running', restConfirmation: 'rest-id', provider: 'grok' },
		{ slug: 'external', status: 'elsewhere', provider: 'kilo' },
		{ slug: 'stopped', status: 'stopped', provider: 'claude' },
		{ slug: 'hibernated', status: 'hibernated', provider: 'codex' },
		{ slug: 'exited', status: 'exited', provider: 'grok' },
		{ slug: 'offline', status: 'offline', provider: 'kilo' },
		{
			slug: 'unverified',
			status: 'unknown',
			provider: 'claude',
			presence: {
				reason: 'process details could not be read',
				observedAt: '2026-10-23T20:30:00.000Z',
			},
		},
	];
	const agents: TeamAgent[] = states.map((agent) => ({ ...agent, name: agent.slug, cwd: '.' }));
	const render = () =>
		roster.replaceChildren(
			...agents.map((agent) => restRosterRow(agent, memberRow(agent, 'resting'), () => {})),
		);
	const visible = () =>
		[...roster.querySelectorAll<HTMLElement>('.member')]
			.filter((row) => !row.hidden)
			.map((row) => row.dataset.slug)
			.join(',');
	const click = (mode: string) => {
		const button = presence.querySelector<HTMLButtonElement>(`[data-presence="${mode}"]`);
		if (!button) throw new Error(`Missing ${mode}`);
		button.click();
		assert(button.getAttribute('aria-pressed') === 'true', `${mode} pressed`);
	};
	providers.replaceChildren();
	presence.replaceChildren();
	localStorage.setItem('summon.hiddenProviders', '[]');
	localStorage.setItem('summon.rosterPresence', 'active');
	render();
	const update = setupProviderFilters(roster);
	assert(presence.textContent === 'AllActiveOnlineOffline', 'presence order');
	assert(visible() === 'working,ready,external', 'restored Active excludes Zzz and offline');
	click('online');
	assert(visible() === 'working,ready,resting,external', 'Online retains Zzz');
	click('offline');
	// Neither online nor offline: an unverified lock is left out of both, and All still shows it.
	assert(
		visible() === 'stopped,hibernated,exited,offline',
		'Offline includes every stopped state but not an unverified lock',
	);
	// An unverified lock is never online: its own label, and a reason and time on its dot. The
	// page loads no stylesheet, so its colour is checked in desktop-css.test.ts and natively.
	const unverified = roster.querySelector<HTMLElement>('[data-slug="unverified"]');
	assert(
		unverified?.querySelector('.member-state')?.textContent === 'Lock held, not verified',
		'unknown reads Lock held, not verified',
	);
	assert(
		unverified
			?.querySelector<HTMLElement>('.dot')
			?.title.startsWith(
				'Lock held, not verified: process details could not be read. Checked ',
			) === true,
		'unknown dot names its reason and observation time',
	);
	click('all');
	assert(roster.querySelectorAll('.member:not([hidden])').length === 9, 'All restores every row');
	click('active');
	assert(localStorage.getItem('summon.rosterPresence') === 'active', 'Active saved');
	update(
		(['claude', 'codex', 'grok', 'kilo'] as const).map((provider) => ({
			provider,
			status: 'available',
			detail: '',
		})),
	);
	providers.querySelector<HTMLButtonElement>('[data-provider="codex"]')?.click();
	assert(visible() === 'working,external', 'provider and Active intersect');
	const resting = agents.find((agent) => agent.slug === 'resting');
	if (!resting) throw new Error('Missing resting agent');
	delete resting.restConfirmation;
	render();
	update();
	assert(visible() === 'working,resting,external', 'rest ending appears on snapshot update');
	resting.restConfirmation = 'new-rest-id';
	render();
	update();
	assert(visible() === 'working,external', 'new rest hides on snapshot update');
	assert(
		roster.querySelector('[aria-current="true"]')?.getAttribute('data-slug') === 'resting',
		'filter does not change selected session',
	);
	return assertions;
}
