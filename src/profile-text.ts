import { createHash } from 'node:crypto';

import type { AgentRecord } from './store.ts';

import { profileTextStale } from './profile-text-stale.ts';

/** The stored bound on each of expertise and domain, the same one Team Maintenance applies. */
const PROFILE_TEXT_LIMIT = 8000;

/**
 * One revision over both texts, so a writer that read either one cannot overwrite a newer edit of
 * the other. JSON framing keeps `["a b", ""]` and `["a", "b"]` distinct.
 * @param text The expertise and domain as stored, an absent domain reading as empty.
 * @returns A sha256 hex digest.
 */
export function profileTextRevision(text: { expertise: string; domain?: string }): string {
	return createHash('sha256')
		.update(JSON.stringify([text.expertise, text.domain ?? '']))
		.digest('hex');
}

export const textHash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A Team Maintenance form sends null while adding, and a sha256 hex revision when editing. */
export function validFormRevision(revision: unknown, creating: boolean): boolean {
	return creating
		? revision === null
		: typeof revision === 'string' && /^[a-f0-9]{64}$/.test(revision);
}

/**
 * Team Maintenance's half of the shared check, run inside updateAgentRecord's record lock. Like
 * notes: text the form did not touch is left as stored, and edited text is refused if anyone
 * (another form, a PM edit) changed it since the form loaded, unless it already matches. Text it
 * writes passes the same character check as the CLI; the form may still leave a field empty.
 * @param profile The record as reread under the lock.
 * @param input The form's text and the revision it loaded.
 * @param creating True for a new teammate, which has no stored text to protect.
 */
export function applyFormText(
	profile: AgentRecord,
	input: { expertise: string; domain: string; profileRevision: string | null },
	creating: boolean,
): void {
	if (!creating && profileTextRevision(input) === input.profileRevision) return;
	const clean = (label: string, text: string): string =>
		text.trim() ? validProfileText(label, text) : '';
	const typed = {
		expertise: clean('Expertise', input.expertise),
		domain: clean('Domain', input.domain),
	};
	const stored = profileTextRevision(profile);
	if (!creating && stored !== input.profileRevision && stored !== profileTextRevision(typed))
		throw new Error(profileTextStale);
	profile.expertise = typed.expertise;
	profile.domain = typed.domain;
}

/**
 * Tab and line feed are prose. Every other C0/C1 control, and the bidirectional controls (overrides,
 * embeddings, isolates and marks) that make text display differently from what it says, are refused
 * rather than stored for a prompt to read.
 */
const DISALLOWED = /(?![\t\n])\p{Cc}|\p{Bidi_Control}/u;

/**
 * Normalize and bound one registration text field.
 * @param label The field name, for the error.
 * @param text The text as supplied.
 * @returns The trimmed text with CRLF line endings normalized to LF.
 */
export function validProfileText(label: string, text: string): string {
	const value = text.replace(/\r\n/g, '\n').trim();
	if (!value) throw new Error(`${label} text is empty. Use the explicit clear flag to clear it.`);
	if (value.length > PROFILE_TEXT_LIMIT)
		throw new Error(`${label} exceeds ${PROFILE_TEXT_LIMIT} characters.`);
	if (DISALLOWED.test(value))
		throw new Error(
			`${label} contains a control or bidirectional-override character. Only tab and line breaks are allowed.`,
		);
	return value;
}
