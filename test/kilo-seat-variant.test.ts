import { afterEach, beforeEach, expect, test } from 'bun:test';

import { kiloCatalog } from '../src/kilo-variant-check.ts';
import { loadAgent } from '../src/store.ts';
import { profileFor, saveProfile, type TeamProfile } from '../src/team-maintenance.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
const realList = kiloCatalog.list;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	// Saving a new variant asks Kilo's model list; a fixture answers instead of the real CLI.
	kiloCatalog.list = () => Promise.resolve({ variants: ['low', 'medium', 'high'] });
});
afterEach(async () => {
	kiloCatalog.list = realList;
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});
const rejected = async (work: Promise<unknown>, text: string): Promise<void> => {
	expect(await work.catch((error: unknown) => String(error))).toContain(text);
};

const kiloProfile = (): TeamProfile => ({
	memberType: 'teammate',
	canStopResting: false,
	displayName: 'ember',
	name: 'ember',
	provider: 'kilo',
	cwd: fixture.root,
	expertise: 'Testing',
	domain: 'Fixtures',
	backup: '',
	notes: '',
	notesRevision: null,
	profileRevision: null,
	sessionId: 'ses_known',
	model: 'zai/glm-5.3',
	variant: 'high',
});

/** The profile as the form would resend it after loading. */
async function reloaded(): Promise<TeamProfile> {
	return { ...(await profileFor('ember')) };
}

/** The same, from a form that has no variant field at all. */
async function reloadedWithoutField(): Promise<TeamProfile> {
	const profile = await reloaded();
	delete profile.variant;
	return profile;
}

test('a Kilo seat keeps its registered variant through the maintenance form', async () => {
	expect(await saveProfile(kiloProfile(), null)).toBe('ember');
	expect((await loadAgent('ember'))?.variant).toBe('high');
	expect((await profileFor('ember')).variant).toBe('high');

	// Today's form sends no variant field: saving must keep the setting, not wipe it.
	await saveProfile(await reloadedWithoutField(), 'ember');
	expect((await loadAgent('ember'))?.variant).toBe('high');

	// An empty field clears it.
	await saveProfile({ ...(await reloaded()), variant: '' }, 'ember');
	expect((await loadAgent('ember'))?.variant).toBeUndefined();
	expect(await profileFor('ember')).not.toHaveProperty('variant');
});

test('the form refuses a variant without Kilo and a model, or with a bad name', async () => {
	await rejected(saveProfile({ ...kiloProfile(), model: '' }, null), 'requires Kilo and a model');
	await rejected(saveProfile({ ...kiloProfile(), variant: 'default' }, null), 'requires Kilo');
	await rejected(saveProfile({ ...kiloProfile(), variant: 'hi gh' }, null), 'requires Kilo');
	await rejected(
		saveProfile({ ...kiloProfile(), provider: 'codex', model: undefined }, null),
		'requires Kilo',
	);
	expect(await loadAgent('ember')).toBeUndefined();
});

test('a kept variant goes when the model it depends on is removed', async () => {
	await saveProfile(kiloProfile(), null);
	await saveProfile({ ...(await reloadedWithoutField()), model: '' }, 'ember');
	const record = await loadAgent('ember');
	expect(record?.model).toBeUndefined();
	expect(record?.variant).toBeUndefined();
});
