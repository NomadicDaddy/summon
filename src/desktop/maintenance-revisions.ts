import type { TeamProfile } from '../team-maintenance.ts';

import { kiloSettingsStale } from '../kilo-settings-stale.ts';
import { profileTextStale } from '../profile-text-stale.ts';
import { readableError } from './ipc-error.ts';

type Revisions = Pick<TeamProfile, 'kiloSettingsRevision' | 'notesRevision' | 'profileRevision'>;
interface Element {
	hidden: HTMLElement['hidden'];
	textContent: string | null;
	value?: string;
	classList: { toggle: (token: string, force?: boolean) => boolean };
	addEventListener: (type: 'click', listener: () => void) => void;
}
/** The footer line's attention tone, used only for the stale refusal. */
const ATTENTION = 'maint-attention';
const SHOW_STORED = 'Show stored text';
const SHOW_TYPED = 'Show my text';

/**
 * The revisions this form loaded, sent back on save.
 *
 * Notes: what the notes looked like when this form was filled. Sent back on save so the backend can
 * tell an untouched field from an edited one, and refuse rather than overwrite when the file moved
 * under us. Null while adding, because there is no file to have moved.
 *
 * Profile text: the same for expertise and domain together, which the operator's PM can also edit.
 * After a stale refusal the typed values stay in the form, and one button swaps the two fields
 * between the stored text and the operator's own. Looking at the stored text adopts its revision:
 * saving after that, with either version showing, is a deliberate choice made with it seen.
 *
 * Kilo settings: the same for model, variant and LM Studio URL together, so a form loaded before
 * one of them changed cannot save its older value over the newer one (or erase it). Showing the
 * stored text never adopts this revision, because that swaps only expertise and domain: the model
 * field would still hold the older value. After that refusal the form keeps what was typed and
 * the operator reloads the teammate to see the stored settings; a swap an earlier text refusal
 * offered is withdrawn, unless the operator's own text is set aside and needs it to come back.
 * @param get The dialog's element lookup.
 * @param run The form's busy-guarded action runner.
 * @param editing The registered teammate the form is editing, or null while adding.
 */
export function setupMaintenanceRevisions(
	get: (id: string) => Element,
	run: (work: () => Promise<void>) => void,
	editing: () => string | null,
): {
	fill: (profile: Revisions) => void;
	revisions: () => Revisions;
	refused: (cause: unknown) => never;
} {
	let loaded: Revisions = {
		kiloSettingsRevision: null,
		notesRevision: null,
		profileRevision: null,
	};
	let typed: { expertise: string; domain: string } | undefined;
	const toggle = get('maint-text-stored');
	const expertise = get('maint-expertise');
	const domain = get('maint-domain');
	const status = get('maint-error');
	const say = (text: string): void => {
		status.classList.toggle(ATTENTION, false);
		status.textContent = text;
	};
	toggle.addEventListener('click', () => {
		run(async () => {
			if (typed) {
				expertise.value = typed.expertise;
				domain.value = typed.domain;
				typed = undefined;
				toggle.textContent = SHOW_STORED;
				say('Showing your text. Saving now replaces the stored expertise and domain.');
				return;
			}
			const slug = editing();
			if (slug === null) return;
			const current = await window.team.profile(slug);
			typed = { expertise: expertise.value ?? '', domain: domain.value ?? '' };
			expertise.value = current.expertise;
			domain.value = current.domain;
			loaded = { ...loaded, profileRevision: current.profileRevision };
			toggle.textContent = SHOW_TYPED;
			say(`Showing the stored text. ${SHOW_TYPED} puts your edits back.`);
		});
	});
	return {
		fill: (profile) => {
			loaded = {
				kiloSettingsRevision: profile.kiloSettingsRevision ?? null,
				notesRevision: profile.notesRevision,
				profileRevision: profile.profileRevision,
			};
			typed = undefined;
			toggle.hidden = true;
			toggle.textContent = SHOW_STORED;
			status.classList.toggle(ATTENTION, false);
		},
		revisions: () => loaded,
		refused: (cause) => {
			const message = readableError(cause);
			const stale = message === profileTextStale;
			const kilo = message === kiloSettingsStale;
			if (stale) toggle.hidden = false;
			// After a Kilo refusal the way on is a reload, which refills the text too, so a swap
			// offered by an earlier text refusal goes. Not while the operator's own text is set
			// aside (typed): the button is how they get it back before reloading.
			else if (kilo && typed === undefined) toggle.hidden = true;
			status.classList.toggle(ATTENTION, stale || kilo);
			throw cause;
		},
	};
}
