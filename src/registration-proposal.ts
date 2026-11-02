import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ROOM_TEXT_LIMIT } from './local-room.ts';
import { missing } from './mail-files.ts';
import { textHash } from './profile-text.ts';
import { type Edit, type Field, fields, type Request } from './registration-input.ts';
import { storageRoot } from './store.ts';

export const TAG_START = '[registration-edit';

/** What an edit does to one field, as the tag spells it. */
const fieldTag = (edit: Edit, field: Field): string => {
	const text = edit[field];
	return text === undefined ? 'unchanged' : text === '' ? 'clear' : textHash(text);
};

/**
 * The machine tag that binds an approval to one exact edit: target, the revision it starts from,
 * and for each field the new text's sha256, `clear` or `unchanged`.
 * @param request The parsed edit.
 * @returns The tag, the last line of the approval request.
 */
export function registrationTag(request: Pick<Request, 'target' | 'revision' | 'edit'>): string {
	return `${TAG_START} v1 target=${request.target} revision=${request.revision} expertise=${fieldTag(request.edit, 'expertise')} domain=${fieldTag(request.edit, 'domain')}]`;
}

/** How much of a long text the question quotes beside its proposal file. */
const EXCERPT = 800;

/** Content-addressed: the name is the sha256 of the exact bytes it holds. */
export const proposalPath = (text: string): string =>
	join(storageRoot(), 'registration-proposals', `${textHash(text)}.txt`);

/**
 * The one generator of an approval request's text, used by `request` to post it and by the
 * decision check to require it byte for byte, so nothing can be added to or taken from it.
 *
 * Each changed field's new text appears complete in the question when the whole question fits
 * the room's message limit. Otherwise every new text lives in a write-once proposal file named by
 * its sha256, and the question gives that path, the character count, the sha256 and an excerpt:
 * the operator's complete review surface is always either the question or that file.
 * @param author The PM posting the request.
 * @param name The target's registered display name.
 * @param request The exact edit.
 * @returns The question text, and the fields whose full text is in a proposal file.
 */
export function requestPlan(
	author: string,
	name: string,
	request: Pick<Request, 'target' | 'revision' | 'edit'>,
): { text: string; proposals: Field[] } {
	const head = `${author} asks to change ${name}'s registered text. Registration text only: no other field, and no session is started, woken or stopped. Yes lets ${author} make exactly this edit.`;
	const compose = (inline: boolean): string =>
		[
			head,
			...fields.flatMap((field) => {
				const text = request.edit[field];
				if (text === undefined) return [];
				if (text === '') return [`${field}: clear (empty)`];
				// Keyed to the text's own digest, which the text cannot contain, so a line inside it
				// cannot pass as the end marker and make the rest read as commentary.
				const key = textHash(text).slice(0, 16);
				if (inline)
					return [
						`--- new ${field} ${key}, complete, ${text.length} characters ---`,
						text,
						`--- end of new ${field} ${key} ---`,
					];
				return [
					`--- new ${field} ${key}: ${text.length} characters, sha256 ${textHash(text)}; the complete text is in ${proposalPath(text)}; first ${EXCERPT} characters only ---`,
					Array.from(text).slice(0, EXCERPT).join(''),
					`--- excerpt ${key} ends; read the file above for the complete ${field} ---`,
				];
			}),
			registrationTag(request),
		].join('\n');
	const inline = compose(true);
	if (inline.length <= ROOM_TEXT_LIMIT) return { text: inline, proposals: [] };
	const excerpted = compose(false);
	if (excerpted.length > ROOM_TEXT_LIMIT)
		throw new Error('This approval request would exceed the Team Room message limit.');
	return {
		text: excerpted,
		proposals: fields.filter((field) => Boolean(request.edit[field])),
	};
}

async function existing(path: string): Promise<string | undefined> {
	const info = await lstat(path).catch((error: unknown) => {
		if (missing(error)) return undefined;
		throw error;
	});
	if (!info) return undefined;
	if (!info.isFile() || info.isSymbolicLink())
		throw new Error(`Proposal ${path} is not a regular file.`);
	return readFile(path, 'utf8');
}

/**
 * Write once. A file already at that name must hold exactly these bytes; anything else is refused
 * rather than overwritten.
 * @param text The exact normalized new text.
 */
export async function writeProposal(text: string): Promise<void> {
	const path = proposalPath(text);
	await mkdir(dirname(path), { recursive: true });
	const current = await existing(path);
	if (current === undefined) {
		await writeFile(path, text, { encoding: 'utf8', flag: 'wx' });
		return;
	}
	if (current !== text)
		throw new Error(
			`Proposal ${path} already exists with different content; it was not replaced.`,
		);
}

/**
 * At edit time: the proposal the operator was pointed at must still exist and hash to the tag.
 * @param field The field, for the message.
 * @param text The edit's new text, whose hash the tag already carries.
 */
export async function verifyProposal(field: Field, text: string): Promise<void> {
	const path = proposalPath(text);
	const current = await existing(path);
	if (current === undefined)
		throw new Error(
			`The approved ${field} proposal ${path} is missing. Request approval again.`,
		);
	if (textHash(current) !== textHash(text))
		throw new Error(
			`The approved ${field} proposal ${path} changed after the request; it no longer matches the approval. Request approval again.`,
		);
}
