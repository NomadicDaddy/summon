import type { TeamAgent } from '../../src/desktop/types.ts';
import type { TeamProfile } from '../../src/team-maintenance.ts';

/*
 * Team Maintenance's Save while the dialog is busy (kilo-model-selection-persistence, 2026-10-24).
 * The real dialog code against a stubbed window.team: an existing Kilo seat whose profile load is
 * held open, so the dialog is busy exactly as it is while a slow load, Team settings or a usage
 * refresh runs. Before the fix Save stayed enabled through that and a press was dropped without a
 * word; now it must be off for as long as the action runs, then save the typed model, keep typed
 * values when a save is refused, and stay off when there is no CLI to add a teammate with.
 */
const stored: TeamProfile = {
	backup: '',
	canStopResting: false,
	cwd: 'C:/work/pablo',
	displayName: 'pablo',
	domain: 'Fixtures',
	expertise: 'Testing',
	memberType: 'teammate',
	model: 'zai-coding-plan/glm-5.3',
	name: 'pablo',
	notes: '',
	notesRevision: 'a'.repeat(64),
	profileRevision: 'b'.repeat(64),
	provider: 'kilo',
	sessionId: '',
};
let installed = ['kilo', 'claude'];
let holdProfile = false;
let release: (() => void) | undefined;
let refuseNextSave = false;
const saves: TeamProfile[] = [];
const never = (): Promise<never> => new Promise<never>(() => {});
const api: Record<string, (...args: never[]) => Promise<unknown>> = {
	gallery: () => Promise.resolve({ templates: [], warnings: [] }),
	installedProviders: () => Promise.resolve(installed),
	profile: async () => {
		if (holdProfile) await new Promise<void>((resolve) => (release = resolve));
		return { ...stored };
	},
	saveProfile: (profile: TeamProfile) => {
		saves.push(profile);
		if (refuseNextSave) {
			refuseNextSave = false;
			return Promise.reject(new Error('Refused by the fixture.'));
		}
		stored.model = profile.model ?? '';
		return Promise.resolve({ slug: 'pablo' });
	},
	saveSettings: () =>
		Promise.resolve({
			autoHold: true,
			claudeDelivery: 'checkpoint',
			holdSeconds: 30,
			wakeOnMention: true,
		}),
	select: () => Promise.resolve(),
	settings: () =>
		Promise.resolve({
			autoHold: true,
			claudeDelivery: 'checkpoint',
			holdSeconds: 30,
			wakeOnMention: true,
		}),
};
// Anything the dialog asks for beyond these is never answered, which no step here waits on.
(window as unknown as { team: unknown }).team = new Proxy(api, {
	get: (target, key: string) => target[key] ?? never,
});

const element = (id: string): HTMLElement => {
	const node = document.getElementById(id);
	if (!node) throw new Error(`missing ${id}`);
	return node;
};
const until = async (ready: () => boolean): Promise<void> => {
	for (let waited = 0; !ready(); waited += 20) {
		if (waited > 5000) throw new Error('fixture step timed out');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

async function main(): Promise<void> {
	const { setupMaintenance } = await import('../../src/desktop/maintenance.ts');
	const maintenance = setupMaintenance(
		() => {},
		() => {},
	);
	const agent = {
		name: 'pablo',
		provider: 'kilo',
		slug: 'pablo',
		status: 'offline',
	} as TeamAgent;
	maintenance.update({ agents: [agent], selected: 'pablo' });
	const save = element('maint-save') as HTMLButtonElement;
	const model = element('maint-model') as HTMLInputElement;
	const status = element('maint-error');

	// 1. Busy: the profile load is held open. Save must be off, and a press must not reach a save.
	holdProfile = true;
	element('maintenance-toggle').click();
	await until(() => release !== undefined);
	const duringLoad = { saveDisabled: save.disabled };
	save.click();
	await new Promise((resolve) => setTimeout(resolve, 200));
	const savesDuringLoad = saves.length;
	holdProfile = false;
	release?.();
	// Done loading is the stored model in the field, not Save's state, which is what is under test.
	await until(() => model.value === stored.model);
	await new Promise((resolve) => setTimeout(resolve, 200));
	const afterLoad = { model: model.value, saveDisabled: save.disabled };

	// 2. The typed model is what gets saved, and Save comes back with its own label.
	model.value = 'kilo/poolside/laguna-s-2.1:free';
	save.click();
	await until(() => saves.length === 1 && !save.disabled);
	const saved = {
		label: save.textContent.trim(),
		model: saves[0]?.model,
		saveDisabled: save.disabled,
	};

	// 3. A refused save keeps what was typed and gives Save back.
	refuseNextSave = true;
	model.value = 'other/model';
	save.click();
	await until(() => saves.length === 2 && !save.disabled);
	const refused = { model: model.value, saveDisabled: save.disabled, status: status.textContent };

	// 4. Adding with no CLI installed: Save stays off once the load is done.
	(element('maintenance') as HTMLDialogElement).close();
	installed = [];
	maintenance.add();
	await until(() => !element('maint-no-cli').hidden);
	await new Promise((resolve) => setTimeout(resolve, 200));
	const noCli = { saveDisabled: save.disabled };

	document.title = `MAINT_BUSY ${JSON.stringify({ afterLoad, duringLoad, noCli, refused, saved, savesDuringLoad })}`;
}
main().catch((error: unknown) => {
	document.title = `MAINT_BUSY ${JSON.stringify({ error: String(error) })}`;
});
