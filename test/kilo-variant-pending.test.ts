import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { TeamAgent } from '../src/desktop/types.ts';

import { renderWelcome } from '../src/desktop/onboarding.ts';
import { savedText, savingProfile } from '../src/desktop/provider-fields.ts';
import { kiloCatalog } from '../src/kilo-variant-check.ts';
import { loadAgent } from '../src/store.ts';
import { profileFor, saveProfile, type TeamProfile } from '../src/team-maintenance.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

/*
 * The Team Maintenance side of the Kilo variant check (Carl #20331, Morticia #20396): a save that
 * may wait up to 45 s on Kilo says so while it runs, and a "check skipped" note reaches the form
 * instead of only the log.
 */
let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
const realList = kiloCatalog.list;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	kiloCatalog.list = realList;
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

const kiloProfile = (): TeamProfile => ({
	backup: '',
	canStopResting: false,
	cwd: fixture.root,
	displayName: 'ember',
	domain: 'Fixtures',
	expertise: 'Testing',
	memberType: 'teammate',
	model: 'zai/glm-5.3',
	name: 'ember',
	notes: '',
	notesRevision: null,
	profileRevision: null,
	provider: 'kilo',
	sessionId: 'ses_known',
	variant: 'high',
});

test('a skipped check reaches the caller as a note, and the variant is still saved', async () => {
	kiloCatalog.list = () => Promise.resolve({ skipped: "Kilo's model list could not be read" });
	const notes: string[] = [];
	expect(await saveProfile(kiloProfile(), null, (note) => notes.push(note))).toBe('ember');
	expect(notes).toEqual([
		"Reasoning variant high saved without a check: Kilo's model list could not be read.",
	]);
	expect((await loadAgent('ember'))?.variant).toBe('high');
	// The control: a confirmed variant reports nothing.
	kiloCatalog.list = () => Promise.resolve({ variants: ['low', 'high'] });
	const reloaded = { ...(await profileFor('ember')), variant: 'low' };
	await saveProfile(reloaded, 'ember', (note) => notes.push(note));
	expect((await loadAgent('ember'))?.variant).toBe('low');
	expect(notes).toHaveLength(1);
});

test('the saved message carries the note only when there is one', () => {
	expect(savedText()).toBe('Saved. The teammate has not been launched.');
	expect(savedText('Reasoning variant high saved without a check: why.')).toBe(
		'Saved. Reasoning variant high saved without a check: why. The teammate has not been launched.',
	);
});

test('Save reads Saving… and is disabled while it waits, then comes back as it was', async () => {
	const button = { disabled: false, textContent: 'Save' };
	const status = { textContent: '' };
	const get = (id: string) => (id === 'maint-save' ? button : status) as unknown as HTMLElement;
	let release = (): void => {};
	const pending = savingProfile(
		get,
		'high',
		() => new Promise<string>((done) => (release = () => done('ember'))),
	);
	expect(button).toEqual({ disabled: true, textContent: 'Saving…' });
	expect(status.textContent).toContain('checked with Kilo, which can take up to 45 seconds');
	release();
	expect(await pending).toBe('ember');
	expect(button).toEqual({ disabled: false, textContent: 'Save' });
	// A refused save restores the button too, and a save with no variant says nothing about Kilo.
	status.textContent = '';
	const refused = savingProfile(get, '', () => Promise.reject(new Error('refused')));
	expect(status.textContent).toBe('');
	expect(await refused.catch((error: unknown) => String(error))).toBe('Error: refused');
	expect(button).toEqual({ disabled: false, textContent: 'Save' });
});

/*
 * Roger #20464: Add Teammate closes the dialog straight after saving, so a note shown only in the
 * form was gone. The empty pane the operator lands on, "<name> has been added.", carries it.
 */
test('a new teammate keeps the save note on the pane it lands on', () => {
	const nodes = new Map<
		string,
		{ classList: { toggle: () => void }; dataset: object; hidden: boolean; textContent: string }
	>();
	const get = (id: string) => {
		const node = nodes.get(id) ?? {
			classList: { toggle: () => {} },
			dataset: {},
			hidden: false,
			textContent: '',
		};
		nodes.set(id, node);
		return node as unknown as HTMLElement;
	};
	const added: TeamAgent = {
		activity: 'idle',
		cwd: '.',
		name: 'ember',
		provider: 'kilo',
		slug: 'ember',
		status: 'offline',
	};
	const note =
		"Reasoning variant high saved without a check: Kilo's model list could not be read.";
	renderWelcome(get, added, 'ember', false, note);
	expect(nodes.get('empty-title')?.textContent).toBe('ember has been added.');
	expect(nodes.get('empty-detail')?.textContent).toBe(
		`${note} Nothing is running yet. Start ember to open their session in this window.`,
	);
	// The control: an add with no note reads exactly as before.
	renderWelcome(get, added, 'ember', false);
	expect(nodes.get('empty-detail')?.textContent).toBe(
		'Nothing is running yet. Start ember to open their session in this window.',
	);
});
