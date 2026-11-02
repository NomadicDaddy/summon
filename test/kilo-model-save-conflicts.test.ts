import { afterEach, beforeEach, expect, test } from 'bun:test';

import { kiloCatalog } from '../src/kilo-variant-check.ts';
import { loadAgent, newRecord, saveAgent, updateAgentRecord } from '../src/store.ts';
import { profileFor, saveProfile } from '../src/team-maintenance.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
const realList = kiloCatalog.list;
const modelA = 'gateway/fixture-model-a:free';
const modelB = 'gateway/fixture-model-b:free';
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	kiloCatalog.list = () => Promise.resolve({ variants: ['low', 'high'] });
	await saveAgent('member', newRecord('Member', fixture.root, 'kilo'));
});
afterEach(async () => {
	kiloCatalog.list = realList;
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

test('an older empty-model form cannot erase a newer model while saving notes', async () => {
	const newer = await profileFor('member');
	const stale = await profileFor('member');
	await saveProfile({ ...newer, model: modelA }, 'member');
	const before = await fixture.read('member.json');
	const typed = { ...stale, notes: 'Typed in the older window' };
	const result: unknown = await saveProfile(typed, 'member').catch((error: unknown) => error);
	expect(result).toBeInstanceOf(Error);
	expect(String(result)).toContain('settings changed');
	expect(await fixture.read('member.json')).toBe(before);
	expect((await loadAgent('member'))?.model).toBe(modelA);
	expect(typed.notes).toBe('Typed in the older window');
});

test('stale clear refuses; a reloaded deliberate model clear still works', async () => {
	await saveProfile({ ...(await profileFor('member')), model: modelA }, 'member');
	const stale = await profileFor('member');
	await saveProfile({ ...(await profileFor('member')), model: modelB }, 'member');
	const result: unknown = await saveProfile({ ...stale, model: '' }, 'member').catch(
		(error: unknown) => error,
	);
	expect(result).toBeInstanceOf(Error);
	expect((await loadAgent('member'))?.model).toBe(modelB);
	await saveProfile({ ...(await profileFor('member')), model: '' }, 'member');
	expect((await loadAgent('member'))?.model).toBeUndefined();
});

test('model observations do not invalidate the loaded model settings', async () => {
	await saveProfile({ ...(await profileFor('member')), model: modelA }, 'member');
	const form = await profileFor('member');
	await updateAgentRecord('member', (record) => {
		record.modelInfo = {
			model: 'observed-model',
			provider: 'kilo',
			sessionId: 'observed-session',
			observedAt: new Date().toISOString(),
		};
	});
	await saveProfile({ ...form, notes: 'Unrelated notes edit' }, 'member');
	const current = await loadAgent('member');
	expect(current?.model).toBe(modelA);
	expect(current?.modelInfo?.model).toBe('observed-model');
});

test('an older form cannot overwrite a changed registered variant', async () => {
	await saveProfile({ ...(await profileFor('member')), model: modelA, variant: 'low' }, 'member');
	const stale = await profileFor('member');
	await saveProfile({ ...(await profileFor('member')), variant: 'high' }, 'member');
	const before = await fixture.read('member.json');
	const result: unknown = await saveProfile({ ...stale, notes: 'Typed note' }, 'member').catch(
		(error: unknown) => error,
	);
	expect(String(result)).toContain('settings changed');
	expect(await fixture.read('member.json')).toBe(before);
});

test('an older form cannot overwrite a changed LM Studio URL', async () => {
	await saveProfile(
		{
			...(await profileFor('member')),
			model: 'lmstudio/fixture-model',
			lmStudioUrl: 'http://localhost:1234',
		},
		'member',
	);
	const stale = await profileFor('member');
	await saveProfile(
		{ ...(await profileFor('member')), lmStudioUrl: 'http://localhost:5678' },
		'member',
	);
	const before = await fixture.read('member.json');
	const result: unknown = await saveProfile({ ...stale, notes: 'Typed note' }, 'member').catch(
		(error: unknown) => error,
	);
	expect(String(result)).toContain('settings changed');
	expect(await fixture.read('member.json')).toBe(before);
});

test('missing or malformed edit revisions refuse without writing registration or notes', async () => {
	await saveProfile({ ...(await profileFor('member')), model: modelA }, 'member');
	const form = await profileFor('member');
	const before = await fixture.read('member.json');
	const notes = await fixture.read('member.md').catch(() => null);
	for (const revision of [undefined, null, 'bad-revision']) {
		const result: unknown = await saveProfile(
			{ ...form, kiloSettingsRevision: revision, notes: 'Do not write' },
			'member',
		).catch((error: unknown) => error);
		expect(String(result)).toContain('Invalid Kilo settings revision');
		expect(await fixture.read('member.json')).toBe(before);
		expect(await fixture.read('member.md').catch(() => null)).toBe(notes);
	}
});

test('a settings edit arriving during variant validation is caught before any form write', async () => {
	await saveProfile({ ...(await profileFor('member')), model: modelA }, 'member');
	const form = await profileFor('member');
	let enter = (): void => {};
	let release = (): void => {};
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	kiloCatalog.list = async () => {
		enter();
		await gate;
		return { variants: ['high'] };
	};
	const saving = saveProfile(
		{ ...form, variant: 'high', notes: 'Typed during check' },
		'member',
	).catch((error: unknown) => error);
	try {
		await entered;
		await updateAgentRecord('member', (record) => {
			record.model = modelB;
		});
		const before = await fixture.read('member.json');
		release();
		expect(String(await saving)).toContain('settings changed');
		expect(await fixture.read('member.json')).toBe(before);
	} finally {
		release();
		await saving;
	}
});
