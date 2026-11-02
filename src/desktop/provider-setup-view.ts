import type { CapabilityValue, ProviderSetup, ProviderSetupCatalog } from '../provider-setup.ts';
import type { CliStatus } from './cli-status.ts';

import { firstRunSummary, prerequisiteSummary, setupSummary } from './cli-summary.ts';
import { reportFault } from './fault-report.ts';
import { keepFocus } from './maintenance-tabs.ts';

/**
 * CLI setup: what is installed here, how to get the rest, what each needs, and what Summon does
 * with each (#5308).
 *
 * Every fact on this surface comes from the catalog in ../provider-setup.ts, which is Morgan's and
 * was checked against the providers' own documentation. Nothing here states a fact of its own; the
 * only things decided in this file are the arrangement and the words for the three check results.
 *
 * Those words are chosen against one misreading. The check runs `<cli> --version` and nothing
 * else, so "Found" is all it can honestly say - a CLI that answers its version check may still be
 * signed out, and a badge reading "Ready" would be this window vouching for something it never
 * looked at. The catalog's discovery note says so in full and is always on screen beside them.
 */
const STATUS_WORDS: Record<CliStatus['status'], string> = {
	available: 'Found',
	missing: 'Not found',
	unavailable: 'Check failed',
};

const SUPPORT_WORDS: Record<CapabilityValue['support'], string> = {
	no: 'No',
	partial: 'Partial',
	yes: 'Yes',
};

let catalogRequest: Promise<ProviderSetupCatalog> | undefined;

/** One read of the catalog for the whole window: it is static, and two surfaces draw from it. */
export function providerCatalog(): Promise<ProviderSetupCatalog> {
	catalogRequest ??= window.team.providerSetup().catch((cause: unknown) => {
		catalogRequest = undefined;
		throw cause;
	});
	return catalogRequest;
}

function node<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const made = document.createElement(tag);
	if (className) made.className = className;
	if (text !== undefined) made.textContent = text;
	return made;
}

/** A link that leaves the window through the validated opener, never by navigating it. */
function guideLink(text: string, url: string, failed: (message: string) => void): HTMLElement {
	const link = node('a', 'cli-setup-link', text);
	link.href = url;
	link.title = url;
	link.addEventListener('click', (event) => {
		event.preventDefault();
		window.team.openRoomUrl(url).catch(() => {
			failed(`That link could not be opened. Its address is ${url}`);
		});
	});
	return link;
}

function providerCard(
	setup: ProviderSetup,
	status: CliStatus | undefined,
	failed: (message: string) => void,
): HTMLElement {
	const card = node('section', 'cli-setup-card');
	card.dataset.provider = setup.provider;
	card.dataset.status = status?.status ?? 'unknown';
	const head = node('div', 'cli-setup-card-head');
	head.append(
		node('h3', '', setup.name),
		node(
			'span',
			`cli-status-${status?.status ?? 'missing'}`,
			status ? STATUS_WORDS[status.status] : 'Not checked',
		),
	);
	card.append(head, node('p', 'cli-setup-detail', status?.detail ?? 'Not checked yet.'));
	const part = (label: string, text: string, link?: HTMLElement): void => {
		const block = node('div', 'cli-setup-part');
		block.append(node('h4', '', label), node('p', '', text));
		if (link) block.append(link);
		card.append(block);
	};
	part(
		'Install',
		setup.installText,
		guideLink('Official installation guide', setup.installUrl, failed),
	);
	part(
		'Account',
		setup.accountText,
		guideLink('Official account and plan details', setup.accountUrl, failed),
	);
	part('Sign in', setup.signInText);
	// The descriptive half of the comparison (#4824). These stay prose on purpose: how a CLI asks
	// for approval, or where its model runs, does not reduce to yes or no without lying a little.
	part('Approvals', setup.approvalText);
	part('Tools', setup.toolingText);
	part('Where it runs', setup.executionText);
	part('Mail delivery', `${setup.behaviour.delivery} ${setup.behaviour.startup}`);
	part('Suited to', setup.behaviour.suitedTo);
	return card;
}

function matrix(catalog: ProviderSetupCatalog): HTMLElement {
	const table = node('table', 'cli-setup-matrix');
	table.append(node('caption', '', 'What Summon does with each CLI'));
	const head = table.createTHead().insertRow();
	const corner = node('th', '', 'CLI');
	corner.scope = 'col';
	head.append(corner);
	for (const column of catalog.columns) {
		const heading = node('th', '', column.label);
		heading.scope = 'col';
		head.append(heading);
	}
	const body = table.createTBody();
	for (const setup of catalog.providers) {
		const row = body.insertRow();
		const name = node('th', '', setup.name);
		name.scope = 'row';
		row.append(name);
		for (const column of catalog.columns) {
			const value = setup.capabilities[column.key];
			const cell = row.insertCell();
			cell.dataset.support = value.support;
			// The word carries the answer; the colour only repeats it.
			cell.append(node('strong', '', SUPPORT_WORDS[value.support]));
			if (value.note) cell.append(node('span', 'cli-setup-cell-note', value.note));
		}
	}
	return table;
}

function renderProviderSetup(
	target: HTMLElement,
	catalog: ProviderSetupCatalog,
	statuses: CliStatus[],
	failed: (message: string) => void,
): void {
	const cards = node('div', 'cli-setup-cards');
	for (const setup of catalog.providers)
		cards.append(
			providerCard(
				setup,
				statuses.find((entry) => entry.provider === setup.provider),
				failed,
			),
		);
	// Built from its three numbers, not parsed: a bare calendar date handed to Date is read as UTC
	// midnight, which is the previous day for anyone west of Greenwich.
	const [year = 0, month = 1, day = 1] = catalog.checkedAt.split('-').map(Number);
	const checked = new Date(year, month - 1, day).toLocaleDateString(undefined, {
		dateStyle: 'long',
	});
	target.replaceChildren(
		node('p', 'cli-setup-discovery', catalog.discoveryNote),
		cards,
		matrix(catalog),
		node('p', 'cli-setup-note', catalog.matrixNote),
		node('p', 'cli-setup-note', catalog.common),
		node('p', 'cli-setup-note', catalog.runtimeNote),
		node(
			'p',
			'cli-setup-note cli-setup-checked',
			`Installation, account and capability details were checked against the official sources on ${checked}.`,
		),
	);
}

/**
 * The guide leads when a required runtime or provider is absent or unchecked. Called from every
 * render, because either can finish last and each knows only half of the answer.
 */
export function leadWithSetup(get: (id: string) => HTMLElement): void {
	const empty = get('empty');
	const lead =
		!get('empty-setup').hidden &&
		(empty.dataset.noCli === 'true' || empty.dataset.prerequisitesMissing === 'true');
	get('empty-setup').classList.toggle('primary', lead);
	get('empty-start').classList.toggle('primary', !lead);
}

/**
 * Wires the surface: an automatic check when the window loads and whenever Maintenance opens, the
 * same check on Refresh, and the first-run summary in the empty window.
 *
 * The check is automatic because the people who most need its answer are the ones who do not yet
 * know there is a button to ask for it. It is not routed through the maintenance dialog's busy
 * guard, as the old Refresh was: that guard freezes the whole form, and reading four version
 * numbers is no reason to stop somebody typing a teammate's name.
 */
export function setupProviderSetup(
	get: (id: string) => HTMLElement,
	open: () => Promise<void>,
	onCliStatus: (statuses: CliStatus[]) => void,
): void {
	const section = get('maint-cli-setup');
	const body = get('maint-cli-status');
	const summary = get('maint-cli-summary');
	const problem = get('maint-cli-problem');
	const refresh = get('maint-cli-refresh') as HTMLButtonElement;
	const firstRun = get('empty-cli');
	const failed = (message: string): void => {
		Object.assign(problem, { hidden: false, textContent: message });
		reportFault({ level: 'error', source: 'cli-setup', text: message });
	};
	const probe = async (): Promise<void> => {
		const refocus = keepFocus(get('maintenance'));
		onCliStatus([]);
		refresh.disabled = true;
		problem.hidden = true;
		summary.textContent = 'Checking…';
		firstRun.textContent = 'Checking required tools and provider CLIs…';
		body.replaceChildren();
		get('empty').dataset.prerequisitesMissing = 'true';
		leadWithSetup(get);
		try {
			const [catalog, statuses, prerequisites] = await Promise.all([
				providerCatalog(),
				window.team.cliStatus(),
				window.team.runtimePrerequisites(),
			]);
			renderProviderSetup(body, catalog, statuses, failed);
			onCliStatus(statuses);
			const names = new Map(catalog.providers.map((setup) => [setup.provider, setup.name]));
			const runtimeSummary = prerequisiteSummary(catalog.prerequisites, prerequisites);
			summary.textContent = `${runtimeSummary} ${setupSummary(statuses, names)}`;
			firstRun.textContent = `${runtimeSummary} ${firstRunSummary(statuses, names)}`;
			get('empty').dataset.prerequisitesMissing = String(
				!catalog.prerequisites.length ||
					catalog.prerequisites.some(
						(requirement) =>
							!prerequisites.some(
								(entry) =>
									entry.id === requirement.id && entry.status === 'available',
							),
					),
			);
			const anyAvailable = statuses.some((entry) => entry.status === 'available');
			get('empty').dataset.noCli = String(!anyAvailable);
			leadWithSetup(get);
		} catch {
			onCliStatus([]);
			summary.textContent = 'Not checked';
			firstRun.textContent =
				'Required tools could not be checked. Open CLI setup and select Refresh.';
			failed(
				'The required tools and CLI check could not be completed. Select Refresh to try again.',
			);
		} finally {
			refresh.disabled = false;
			refocus();
		}
	};
	// One check at a time. Opening Maintenance and pressing Refresh can both ask while the first is
	// still out; the main process already shares the probe, but two renders finishing in either
	// order would not, so the second caller is handed the first one's promise.
	let running: Promise<void> | undefined;
	const check = (): Promise<void> =>
		(running ??= probe().finally(() => {
			running = undefined;
		}));
	refresh.addEventListener('click', () => void check());
	// Checked again whenever Maintenance opens, however it was opened, so a CLI installed since the
	// window loaded shows without anyone knowing to press Refresh. Watching the attribute rather than
	// hooking each opener means a new way in cannot forget to ask.
	const dialog = get('maintenance') as HTMLDialogElement;
	new MutationObserver(() => {
		if (dialog.open) void check();
	}).observe(dialog, { attributeFilter: ['open'], attributes: true });
	get('empty-setup').addEventListener('click', () => {
		// After the dialog has loaded, not before: loading focuses the name field, and focus scrolls.
		// Done in the other order, the guide opened and was immediately scrolled out of view.
		void open().then(() => {
			refresh.focus();
			section.scrollIntoView({ block: 'start' });
		});
	});
	void check();
}
