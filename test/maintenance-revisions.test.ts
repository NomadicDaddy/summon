import { afterEach, expect, test } from 'bun:test';

import type { TeamProfile } from '../src/team-maintenance.ts';

import { setupMaintenanceRevisions } from '../src/desktop/maintenance-revisions.ts';
import { kiloSettingsStale } from '../src/kilo-settings-stale.ts';
import { profileTextStale } from '../src/profile-text-stale.ts';

class FakeElement {
	hidden = false;
	textContent: string | null = '';
	value = '';
	readonly classes = new Set<string>();
	readonly classList = {
		toggle: (token: string, force?: boolean): boolean => {
			const on = force ?? !this.classes.has(token);
			if (on) this.classes.add(token);
			else this.classes.delete(token);
			return on;
		},
	};
	click: () => void = () => undefined;
	addEventListener(_type: 'click', listener: () => void): void {
		this.click = listener;
	}
}

const original = (globalThis as { window?: unknown }).window;
afterEach(() => {
	(globalThis as { window?: unknown }).window = original;
});

function form(stored: Partial<TeamProfile>) {
	const elements = new Map<string, FakeElement>();
	const get = (id: string): FakeElement => {
		const element = elements.get(id) ?? new FakeElement();
		elements.set(id, element);
		return element;
	};
	// Only the one bridge call this module makes is provided.
	(globalThis as { window?: unknown }).window = {
		team: { profile: () => Promise.resolve(stored) },
	};
	const pending: Promise<void>[] = [];
	const revisions = setupMaintenanceRevisions(
		get,
		(work) => pending.push(work()),
		() => 'beta',
	);
	return { get, revisions, settled: () => Promise.all(pending) };
}

const electronError = (message: string): Error =>
	new Error(`Error invoking remote method 'team:save-profile': Error: ${message}`);

test('an ordinary save carries the loaded revisions and leaves the stored-text control hidden', () => {
	const { get, revisions } = form({});
	revisions.fill({ notesRevision: 'n'.repeat(64), profileRevision: 'p'.repeat(64) });
	expect(revisions.revisions()).toEqual({
		kiloSettingsRevision: null,
		notesRevision: 'n'.repeat(64),
		profileRevision: 'p'.repeat(64),
	});
	expect(get('maint-text-stored').hidden).toBe(true);
	expect(() =>
		revisions.refused(electronError('Notes changed while this form was open.')),
	).toThrow('Notes changed');
	expect(get('maint-text-stored').hidden).toBe(true);
	// Other results, "Saved" included, keep the muted tone.
	expect(get('maint-error').classes.has('maint-attention')).toBe(false);
});

test('a stale refusal keeps typed text and lets the operator swap to the stored text and back', async () => {
	const { get, revisions, settled } = form({
		expertise: 'Stored expertise',
		domain: 'Stored domain',
		profileRevision: 's'.repeat(64),
	});
	revisions.fill({ notesRevision: null, profileRevision: 'p'.repeat(64) });
	get('maint-expertise').value = 'Typed expertise';
	get('maint-domain').value = 'Typed domain';
	expect(() => revisions.refused(electronError(profileTextStale))).toThrow(profileTextStale);
	const toggle = get('maint-text-stored');
	expect(toggle.hidden).toBe(false);
	expect(get('maint-error').classes.has('maint-attention')).toBe(true);
	expect(get('maint-expertise').value).toBe('Typed expertise');
	toggle.click();
	await settled();
	expect(get('maint-expertise').value).toBe('Stored expertise');
	expect(get('maint-domain').value).toBe('Stored domain');
	expect(toggle.textContent).toBe('Show my text');
	expect(revisions.revisions().profileRevision).toBe('s'.repeat(64));
	toggle.click();
	await settled();
	expect(get('maint-expertise').value).toBe('Typed expertise');
	expect(get('maint-domain').value).toBe('Typed domain');
	expect(get('maint-error').textContent).toContain('Saving now replaces the stored');
	revisions.fill({ notesRevision: null, profileRevision: 'q'.repeat(64) });
	expect(toggle.hidden).toBe(true);
	expect(toggle.textContent).toBe('Show stored text');
	expect(get('maint-error').classes.has('maint-attention')).toBe(false);
});

test('the loaded Kilo settings revision rides every save, and showing stored text never adopts it', async () => {
	const { get, revisions, settled } = form({
		domain: 'Stored domain',
		expertise: 'Stored expertise',
		kiloSettingsRevision: 'k'.repeat(64),
		profileRevision: 's'.repeat(64),
	});
	revisions.fill({
		kiloSettingsRevision: 'm'.repeat(64),
		notesRevision: null,
		profileRevision: 'p'.repeat(64),
	});
	expect(revisions.revisions().kiloSettingsRevision).toBe('m'.repeat(64));
	// A profile-text refusal, then a swap to the stored text: only the text revision is adopted,
	// because the model field still holds what this form loaded.
	expect(() => revisions.refused(electronError(profileTextStale))).toThrow(profileTextStale);
	get('maint-text-stored').click();
	await settled();
	expect(revisions.revisions()).toEqual({
		kiloSettingsRevision: 'm'.repeat(64),
		notesRevision: null,
		profileRevision: 's'.repeat(64),
	});
	// A reload refills the form with the stored settings and their revision.
	revisions.fill({
		kiloSettingsRevision: 'k'.repeat(64),
		notesRevision: null,
		profileRevision: 's'.repeat(64),
	});
	expect(revisions.revisions().kiloSettingsRevision).toBe('k'.repeat(64));
});

test('a Kilo settings refusal is marked for attention without offering the stored-text swap', () => {
	const { get, revisions } = form({});
	revisions.fill({
		kiloSettingsRevision: 'm'.repeat(64),
		notesRevision: null,
		profileRevision: 'p'.repeat(64),
	});
	get('maint-model').value = 'kilo/poolside/laguna-s-2.1:free';
	expect(() => revisions.refused(electronError(kiloSettingsStale))).toThrow(kiloSettingsStale);
	expect(get('maint-error').classes.has('maint-attention')).toBe(true);
	expect(get('maint-text-stored').hidden).toBe(true);
	// The refusal leaves the typed model where it was; nothing here refills the form.
	expect(get('maint-model').value).toBe('kilo/poolside/laguna-s-2.1:free');
});

test('a Kilo refusal after a text refusal withdraws the swap, unless the typed text is set aside', async () => {
	const stored = {
		domain: 'Stored domain',
		expertise: 'Stored expertise',
		profileRevision: 's'.repeat(64),
	};
	const loaded = {
		kiloSettingsRevision: 'm'.repeat(64),
		notesRevision: null,
		profileRevision: 'p'.repeat(64),
	};
	const fresh = form(stored);
	fresh.revisions.fill(loaded);
	expect(() => fresh.revisions.refused(electronError(profileTextStale))).toThrow(
		profileTextStale,
	);
	expect(fresh.get('maint-text-stored').hidden).toBe(false);
	// The reload a Kilo refusal asks for refills the text as well, so the swap is no longer offered.
	expect(() => fresh.revisions.refused(electronError(kiloSettingsStale))).toThrow(
		kiloSettingsStale,
	);
	expect(fresh.get('maint-text-stored').hidden).toBe(true);

	const swapped = form(stored);
	swapped.revisions.fill(loaded);
	swapped.get('maint-expertise').value = 'Typed expertise';
	expect(() => swapped.revisions.refused(electronError(profileTextStale))).toThrow(
		profileTextStale,
	);
	swapped.get('maint-text-stored').click();
	await swapped.settled();
	expect(swapped.get('maint-expertise').value).toBe('Stored expertise');
	// Mid-swap the operator's own text is set aside; the button stays so it can come back.
	expect(() => swapped.revisions.refused(electronError(kiloSettingsStale))).toThrow(
		kiloSettingsStale,
	);
	expect(swapped.get('maint-text-stored').hidden).toBe(false);
	swapped.get('maint-text-stored').click();
	await swapped.settled();
	expect(swapped.get('maint-expertise').value).toBe('Typed expertise');
});
