import { join } from 'node:path';

import { assertCommunicationsOpen } from './communication-state.ts';
import { optionalText } from './mail-files.ts';

/** Retries regenerate only the transport timestamp; all other identity and body bytes matter. */
export function sameMailContent(first: string, second: string): boolean {
	const comparable = (text: string) => text.replace(/^Sent: [^\n]*\n/m, '');
	return comparable(first) === comparable(second);
}

const REQUIRED_HEADERS = ['From', 'To', 'Sent', 'ID', 'Kind'];

/**
 * Every header before the first blank line except the generated Sent: sender, recipient, ID, kind
 * and any reply or notice binding. Undefined unless each line is a header, each required header
 * appears exactly once and no header repeats, so a malformed or padded copy never matches.
 */
function envelope(text: string): string | undefined {
	const end = text.indexOf('\n\n');
	if (end === -1) return undefined;
	const lines = text.slice(0, end).split('\n');
	const names = lines.map((line) => /^([A-Za-z-]+): /.exec(line)?.[1]);
	if (names.some((name) => name === undefined) || new Set(names).size !== names.length)
		return undefined;
	if (!REQUIRED_HEADERS.every((name) => names.includes(name))) return undefined;
	return lines.filter((line) => !line.startsWith('Sent: ')).join('\n');
}

/** A fixed message ID is already published at the recipient with different content. */
export class MailIdentityConflictError extends Error {
	constructor() {
		super('Mail publication identity conflicts with retained content.');
		this.name = 'MailIdentityConflictError';
	}
}

/** The retained copy has exactly this attempt's envelope: only the message text differs. */
class MailTextConflictError extends MailIdentityConflictError {
	constructor() {
		super();
		this.name = 'MailTextConflictError';
	}
}

/**
 * For a send whose fixed ID records a one-time event, such as a reader's confirmation of one
 * message: a retained copy with the same envelope means the event was already delivered, perhaps
 * by an attempt that died before recording it, so that ID stands as the outcome whatever its
 * wording, once communications are confirmed open. Any other conflict or failure still throws.
 */
export const alreadyPublished =
	(id: string) =>
	async (error: unknown): Promise<string> => {
		if (!(error instanceof MailTextConflictError)) throw error;
		await assertCommunicationsOpen();
		return id;
	};

/** Check inbox before archive: acknowledgement only moves in that direction. */
export async function publishedMailMatches(
	root: string,
	id: string,
	body: string,
): Promise<boolean> {
	for (const folder of ['inbox', 'archive']) {
		const previous = await optionalText(join(root, folder, `${id}.md`));
		if (previous === undefined) continue;
		if (!sameMailContent(previous, body)) {
			const attempted = envelope(body);
			if (attempted !== undefined && envelope(previous) === attempted)
				throw new MailTextConflictError();
			throw new MailIdentityConflictError();
		}
		return true;
	}
	return false;
}
