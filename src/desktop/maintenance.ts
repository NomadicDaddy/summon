import type { TeamProfile } from '../team-maintenance.ts';
import type { CliStatus } from './cli-status.ts';
import type { TeamSnapshot } from './types.ts';

import { dismissOnOutsideClick } from './dialog-dismiss.ts';
import { faultText, reportFault } from './fault-report.ts';
import { readableError } from './ipc-error.ts';
import { maintenanceBusy } from './maintenance-busy.ts';
import {
	profileFields,
	setupRemoval,
	setupTeamSettings,
	setupUsageReport,
	setupWindowPreferences,
} from './maintenance-controls.ts';
import { setupMaintenanceRevisions } from './maintenance-revisions.ts';
import { keepFocus, type MaintenanceTab, setupMaintenanceTabs } from './maintenance-tabs.ts';
import { setupMemberType } from './member-type.ts';
import { activitySummary } from './observation-unavailable.ts';
import { setupProviderBehaviour } from './provider-behaviour.ts';
import { kiloProfile, savedText, savingProfile, setupProviderFields } from './provider-fields.ts';
import { providerLabels } from './provider-labels.ts';
import { setupProviderSetup } from './provider-setup-view.ts';
import { blankProfile } from './starter-notes.ts';
import { setupTeammateGallery } from './teammate-gallery.ts';

export function setupMaintenance(
	onAdded: (slug: string, note?: string) => void,
	onCliStatus: (statuses: CliStatus[]) => void,
): {
	update: (snapshot: TeamSnapshot) => void;
	add: () => void;
} {
	const get = (id: string): HTMLElement => {
		const node = document.getElementById(id);
		if (!node) throw new Error(`Missing maintenance element ${id}`);
		return node;
	};
	const dialog = get('maintenance') as HTMLDialogElement;
	const select = get('maint-member') as HTMLSelectElement;
	const form = get('maint-form') as HTMLFormElement;
	const error = get('maint-error');
	const activity = get('maint-activity');
	const teamSettings = setupTeamSettings(get, (work) => void run(work));
	// Person saves explicitly; Team settings save as they change.
	let addMode = false;
	const tabs = setupMaintenanceTabs(get, (tab) => {
		get('maint-save').hidden = tab !== 'person';
		get('maint-title').textContent =
			addMode && tab === 'person' ? 'Add teammate' : 'Team Maintenance';
	});
	setupWindowPreferences(get, error);
	const fields = profileFields;
	const field = (key: (typeof fields)[number]) => get(`maint-${key}`) as HTMLInputElement;
	const providerFields = setupProviderFields(get, (work) => void run(work));
	// Gallery changes only character fields, preserving provider and working directory.
	const gallery = setupTeammateGallery(
		form,
		(template) => {
			if (!field('name').disabled) field('name').value = template.suggestedName;
			field('expertise').value = template.expertise;
			field('domain').value = template.domain;
		},
		(cause) => {
			// The gallery reads from disk now, so it can fail where it never could before. It reports
			// into the dialog's own error line rather than the window's, because this failed while the
			// dialog was open and that is where the reader is looking.
			error.textContent = readableError(cause);
			reportFault({ level: 'error', source: 'gallery.load', text: faultText(cause) });
		},
		get('maint-member-type') as HTMLSelectElement,
	);
	const memberType = setupMemberType(get, () => {
		saved = formState();
	});
	setupProviderBehaviour(
		field('provider') as unknown as HTMLSelectElement,
		get('maint-cli-behaviour'),
	);
	// Changing the CLI changes who may cover this teammate, so the cover choices follow it.
	field('provider').addEventListener('change', () => {
		const chosen = field('backup').value;
		coverOptions();
		field('backup').value = chosen;
	});
	let snapshot: TeamSnapshot = { agents: [], selected: '' };
	let existing: string | null = null;
	const busy = maintenanceBusy(get('maint-save') as HTMLButtonElement, select, teamSettings);
	let generation = 0;
	let saved = '';
	const formState = (): string => JSON.stringify(fields.map((key) => field(key).value));
	const mayDiscard = (): boolean =>
		formState() === saved || window.confirm('Discard unsaved profile changes?');
	const showActivity = (): void => {
		const agent = snapshot.agents.find((entry) => entry.slug === existing);
		activity.textContent = agent
			? activitySummary(agent)
			: 'New teammate. Registration does not start a session.';
	};
	// Rebuilt before every fill: a coverer must be an existing teammate, so the choices are the
	// registered names rather than free text, and a teammate is never offered as its own coverer.
	// Teammates on the same CLI are left out too, because cover is there to survive a provider
	// outage and a coverer sharing the provider would go down with it. Saving enforces this as
	// well; offering an impossible choice and then refusing it is worse than not offering it.
	const coverOptions = (): void => {
		const select = field('backup') as unknown as HTMLSelectElement;
		const provider = field('provider').value;
		select.replaceChildren(new Option('Nobody', ''));
		for (const agent of snapshot.agents)
			if (agent.slug !== existing && agent.provider !== provider)
				select.append(new Option(agent.name, agent.name));
	};
	const fill = (profile: TeamProfile): void => {
		// Captured HERE rather than beside the load, because fill runs on every teammate switch and
		// after every successful save. Held anywhere else, switching from one teammate to another
		// would submit the previous one's revision and refuse a save that had no conflict.
		revisions.fill(profile);
		for (const key of fields) field(key).value = profile[key] ?? '';
		// AFTER the fields, never before. The choices depend on this teammate's own CLI, and calling
		// it first filtered against whatever the provider select still showed - the form's default,
		// Claude - so editing Morgan offered Auden, who shares his Codex provider and is the one
		// name the rule exists to exclude, while hiding all four Claude teammates including the Carl
		// the pairing needed. Rebuilding the options then reapplies the saved coverer, because the
		// option has to exist before the value will take.
		coverOptions();
		field('backup').value = profile.backup;
		const agent = snapshot.agents.find((entry) => entry.slug === existing);
		const live = ['running', 'elsewhere', 'unknown'].includes(agent?.status ?? ''); // held counts
		memberType.fill(existing === null ? null : profile, live);
		providerFields.update();
		saved = formState();
		field('name').disabled = existing !== null;
		get('maint-removal').hidden = existing === null;
		for (const id of ['maint-usage-heading', 'maint-usage-refresh', 'maint-usage'])
			get(id).hidden = existing === null;
		(get('maint-confirm') as HTMLInputElement).value = '';
		showActivity();
	};
	const run = async (work: () => Promise<void>): Promise<void> => {
		if (busy.active()) return;
		const refocus = keepFocus(dialog);
		busy.set(true);
		error.textContent = '';
		try {
			await work();
		} catch (cause: unknown) {
			// Unwrapped: Electron's invoke prefix is plumbing, not a message. See ipc-error.ts.
			error.textContent = readableError(cause);
			reportFault({ level: 'error', source: 'maintenance.action', text: faultText(cause) });
		} finally {
			busy.set(false);
			refocus();
		}
	};
	const load = async (): Promise<void> => {
		const ticket = ++generation;
		existing = select.value || null;
		const installed = await window.team.installedProviders();
		const provider = field('provider') as unknown as HTMLSelectElement;
		provider.replaceChildren(
			...installed.map((key) => new Option(providerLabels[key].name, key)),
		);
		const nothingToRunWith = !existing && installed.length === 0;
		busy.setRunnable(!nothingToRunWith);
		// Shown in its own element, not the shared error slot: the slot is cleared at the start of
		// every action, which is right for a transient error and wrong for the reason Save is dead.
		get('maint-no-cli').hidden = !nothingToRunWith;
		get('maint-usage').textContent =
			'Usage not read for this teammate. Account limits are shared; unknown is not unlimited.';
		if (existing) {
			const profile = await window.team.profile(existing);
			if (!installed.includes(profile.provider as keyof typeof providerLabels))
				provider.append(
					new Option(`${profile.provider} (not installed)`, profile.provider),
				);
			if (ticket === generation) fill(profile);
		} else fill(blankProfile(installed[0] ?? ''));
	};
	select.addEventListener('change', () => {
		if (!mayDiscard()) {
			select.value = existing ?? '';
			return;
		}
		void run(async () => {
			await teamSettings.apply();
			await load();
		});
	});
	// Resolves once the dialog has loaded and placed its own focus, so a caller that wants to show
	// a particular part of it can do that afterwards instead of being scrolled away from it.
	const open = (slug: string, adding = false, tab: MaintenanceTab = 'person'): Promise<void> => {
		if (busy.active()) return Promise.resolve();
		addMode = adding;
		for (const node of dialog.querySelectorAll<HTMLElement>('[data-maintenance-only]'))
			node.hidden = adding;
		// Characters are offered only when adding: applying one to somebody who already exists would
		// overwrite what the user wrote, and this dialog has no undo.
		gallery.show(adding);
		dialog.showModal();
		select.value = slug;
		tabs.show(tab);
		return run(async () => {
			await teamSettings.apply();
			await load().finally(gallery.ready);
			if (!slug && tab === 'person') field('name').focus();
		});
	};
	// With nobody registered there is nobody to maintain, so either way in is the add state.
	const openOn = (tab: MaintenanceTab): Promise<void> =>
		open(snapshot.selected, snapshot.agents.length === 0, tab);
	get('maintenance-toggle').addEventListener('click', () => void open(snapshot.selected));
	get('team-settings').addEventListener('click', () => void openOn('team'));
	get('maint-browse').addEventListener('click', () => {
		void run(async () => {
			const directory = await window.team.chooseFolder();
			if (directory !== null) field('cwd').value = directory;
		});
	});
	get('maint-close').addEventListener('click', () => {
		if (!busy.active() && mayDiscard()) dialog.close();
	});
	// Clicking away answers to the same guard as Escape and the close button. This form holds typed
	// work, and a misclick that discarded it silently would be a worse bug than the one being fixed.
	dismissOnOutsideClick(dialog, () => !busy.active() && mayDiscard());
	dialog.addEventListener('cancel', (event) => {
		if (busy.active() || !mayDiscard()) event.preventDefault();
	});
	// Below run deliberately: these close over it, and sitting above its declaration reads as safe.
	const started = (work: () => Promise<void>): void => void run(work);
	const revisions = setupMaintenanceRevisions(get, started, () => existing);
	setupProviderSetup(get, () => openOn('team'), onCliStatus);
	setupUsageReport(get, started, () => existing);
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		void run(async () => {
			const profile: TeamProfile = {
				name: field('name').value,
				provider: field('provider').value,
				cwd: field('cwd').value,
				expertise: field('expertise').value,
				domain: field('domain').value,
				backup: field('backup').value,
				notes: field('notes').value,
				...revisions.revisions(),
				sessionId: field('sessionId').value,
				...kiloProfile(field),
				claudeConfigDir: field('claudeConfigDir').value.trim(),
				// The starter's icon, for a new member only: Start blank has none, and an edit must
				// never replace an avatar the member already has.
				...(existing === null && gallery.chosen() !== 'start-blank'
					? { galleryId: gallery.chosen() }
					: {}),
			};
			const adding = existing === null;
			const { note, slug } = await savingProfile(get, profile.variant ?? '', () =>
				window.team.saveProfile(memberType.apply(profile), existing),
			).catch(revisions.refused);
			existing = slug;
			select.value = slug;
			fill(await window.team.profile(slug));
			error.textContent = savedText(note);
			if (adding) {
				onAdded(slug, note);
				await window.team.select(slug);
				dialog.close();
				document.getElementById('empty-start')?.focus();
			}
		});
	});
	setupRemoval(
		get,
		started,
		() => existing,
		async (archive) => {
			existing = null;
			select.value = '';
			await load();
			error.textContent = archive
				? 'Archived under the registry archives folder and removed from the roster.'
				: 'Deleted summon files. Provider conversations and mail in other inboxes are retained.';
		},
	);
	const update = (value: TeamSnapshot): void => {
		snapshot = value;
		const selected = select.value;
		select.replaceChildren(new Option('Add Teammate', ''));
		for (const agent of value.agents) select.append(new Option(agent.name, agent.slug));
		select.value = selected;
		// Refresh cover choices without discarding an unsaved pick.
		const coverer = field('backup').value;
		coverOptions();
		field('backup').value = coverer;
		showActivity();
	};
	return { update, add: () => void open('', true) };
}
