import type { CliStatus } from '../../src/desktop/cli-status.ts';

import { setupProviderFilters } from '../../src/desktop/provider-filters.ts';
import { setupProviderSetup } from '../../src/desktop/provider-setup-view.ts';
import { providerSetupCatalog } from '../../src/provider-setup.ts';
import { checkPresenceFilters } from './presence-filter-dom.ts';
import { checkRestRoster } from './rest-roster-dom.ts';
import { runtimeRequirements, runtimeResults } from './runtime-prerequisites.ts';

async function check() {
	let assertions = 0;
	const assert = (condition: boolean, reason: string) => {
		assertions++;
		if (!condition) throw new Error(reason);
	};
	const get = (id: string) => {
		const element = document.getElementById(id);
		if (!element) throw new Error(id);
		return element;
	};
	for (const id of [
		'roster',
		'provider-filters',
		'presence-filters',
		'maint-cli-setup',
		'maint-cli-status',
		'maint-cli-summary',
		'maint-cli-problem',
		'empty-cli',
		'empty',
	]) {
		const node = document.createElement('div');
		node.id = id;
		document.body.append(node);
	}
	for (const id of ['maint-cli-refresh', 'empty-setup', 'empty-start']) {
		const node = document.createElement('button');
		node.id = id;
		document.body.append(node);
	}
	const dialog = document.createElement('dialog');
	dialog.id = 'maintenance';
	document.body.append(dialog);
	const providers = ['claude', 'codex', 'grok', 'kilo'] as const;
	for (const provider of providers) {
		const member = document.createElement('div');
		member.className = 'member';
		member.dataset.provider = provider;
		get('roster').append(member);
	}
	localStorage.setItem('summon.hiddenProviders', JSON.stringify(providers));
	localStorage.removeItem('summon.rosterPresence');
	let resolve: (statuses: CliStatus[]) => void = () => {};
	let reject: () => void = () => {};
	let runtimes = runtimeResults('available');
	let runtimeFailure = false;
	const opened: string[] = [];
	let linkFailure = false;
	Object.assign(window, {
		team: {
			providerSetup: () =>
				Promise.resolve({ ...providerSetupCatalog, prerequisites: runtimeRequirements }),
			runtimePrerequisites: () =>
				runtimeFailure
					? Promise.reject(new Error('fixture runtime request failure'))
					: Promise.resolve(runtimes),
			openRoomUrl: (url: string) => {
				opened.push(url);
				return linkFailure
					? Promise.reject(new Error('fixture opener failure'))
					: Promise.resolve();
			},
			cliStatus: () =>
				new Promise<CliStatus[]>((yes, no) => {
					resolve = yes;
					reject = () => no(new Error('fixture check failure'));
				}),
			faultReport: () => Promise.resolve(),
		},
	});
	const update = setupProviderFilters(get('roster'));
	setupProviderSetup(get, () => Promise.resolve(), update);
	const buttons = [...get('provider-filters').querySelectorAll('button')];
	const rows = [...get('roster').querySelectorAll<HTMLElement>('.member')];
	const settle = () => new Promise((done) => setTimeout(done, 0));
	assert(
		buttons.every((b) => b.disabled),
		'pending checks must disable all filters',
	);
	assert(
		rows.every((r) => !r.hidden),
		'pending checks must reveal saved-hidden rows',
	);
	for (const [index, provider] of providers.entries()) {
		const statuses = providers.map((p): CliStatus => ({
			provider: p,
			status: p === provider ? 'available' : 'missing',
			detail: '',
		}));
		resolve(statuses);
		await settle();
		assert(
			buttons.every((b, i) => b.disabled === (i !== index)),
			`${provider} enabled alone`,
		);
		assert(
			rows.every((r, i) => r.hidden === (i === index)),
			`${provider} preference restored`,
		);
		buttons[index]?.click();
		assert(
			rows.every((r) => !r.hidden),
			`${provider} enabled click reveals row`,
		);
		buttons[index]?.click();
		const saved = localStorage.getItem('summon.hiddenProviders');
		const disabled = buttons.find((b) => b.disabled);
		disabled?.dispatchEvent(new MouseEvent('click'));
		assert(
			localStorage.getItem('summon.hiddenProviders') === saved,
			'disabled synthetic clicks must not change preferences',
		);
		get('maint-cli-refresh').click();
		assert(
			buttons.every((b) => b.disabled),
			'refresh disables stale Found results',
		);
	}
	reject();
	await settle();
	assert(
		buttons.every((b) => b.disabled),
		'failed request clears stale availability',
	);
	assert(
		rows.every((r) => !r.hidden),
		'failed request cannot strand hidden teammates',
	);
	get('maint-cli-refresh').click();
	resolve(providers.map((provider) => ({ provider, status: 'unavailable', detail: '' })));
	await settle();
	assert(
		buttons.every((b) => b.disabled),
		'failed individual version checks disable filters',
	);
	let runtimeAssertions = 0;
	const runtimeAssert = (condition: boolean, reason: string): void => {
		runtimeAssertions++;
		if (!condition) throw new Error(reason);
	};
	for (const state of ['missing', 'outdated', 'unavailable', 'available', 'unchecked'] as const) {
		runtimes = state === 'unchecked' ? [] : runtimeResults(state);
		get('maint-cli-refresh').click();
		runtimeAssert(
			!get('maint-cli-status').textContent.includes('fixture available'),
			'refresh shows no runtime detail in CLI setup',
		);
		resolve(providers.map((provider) => ({ provider, status: 'available', detail: '' })));
		await settle();
		// Phillip #26178: the Bun and PowerShell cards are gone from Maintenance. The check itself
		// stays, reported as one line in the CLI setup summary and the first-run summary.
		runtimeAssert(
			!get('maint-cli-status').querySelector('[data-prerequisite], .runtime-prerequisites'),
			`runtime ${state} renders no prerequisite card`,
		);
		runtimeAssert(
			get('maint-cli-summary').textContent.includes(
				state === 'available' ? 'versions found' : 'Bun 1.4.3+',
			),
			`runtime ${state} CLI setup summary`,
		);
		runtimeAssert(
			get('empty-setup').classList.contains('primary') === (state !== 'available'),
			`runtime ${state} setup priority despite found providers`,
		);
		runtimeAssert(
			buttons.every((button) => !button.disabled),
			'runtime checks never become provider filters',
		);
		runtimeAssert(
			get('empty-cli').textContent.includes(
				state === 'available' ? 'versions found' : 'Bun 1.4.3+',
			),
			`runtime ${state} first-run summary`,
		);
	}
	// The checked opener, now exercised through a provider card's installation guide.
	const guide = providerSetupCatalog.providers[0];
	const link = get('maint-cli-status').querySelector<HTMLAnchorElement>(
		`[data-provider="${guide?.provider ?? ''}"] a.cli-setup-link`,
	);
	link?.click();
	await settle();
	runtimeAssert(opened[0] === guide?.installUrl, 'provider guide uses checked opener');
	linkFailure = true;
	link?.click();
	await settle();
	runtimeAssert(
		!get('maint-cli-problem').hidden &&
			get('maint-cli-problem').textContent.includes(guide?.installUrl ?? ''),
		'failed opener exposes the official address without navigating',
	);
	runtimeFailure = true;
	get('maint-cli-refresh').click();
	await settle();
	runtimeAssert(
		!get('maint-cli-status').children.length,
		'failed runtime request clears old cards',
	);
	runtimeAssert(
		get('empty-cli').textContent.includes('could not be checked'),
		'request failure is explicit on first run',
	);
	return {
		assertions,
		runtimeAssertions,
		providers: [...providers],
		presenceAssertions: checkPresenceFilters(),
		restAssertions: checkRestRoster(),
	};
}

Object.assign(window, { filterTest: check() });
