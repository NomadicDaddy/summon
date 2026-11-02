/**
 * The refusal a confirmation gives when the request's inbox copy is gone, in place of a raw
 * ENOENT. Every other error is rethrown unchanged. Owner-only: ownMailbox runs before the archive
 * or confirmed state is touched, so cover access gains nothing. Read-only: it writes nothing,
 * sends nothing and takes no lock. statePath is passed in because mail-read imports this module.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { missing, optionalText } from './mail-files.ts';
import { messageId, ownMailbox } from './mail-identity.ts';
import { mailboxPath } from './mailbox.ts';

export function notInInbox(
	name: string,
	id: string,
	statePath: (name: string, id: string, state: string) => string,
): (error: unknown) => Promise<never> {
	return async (error) => {
		if (!missing(error)) throw error;
		ownMailbox(name);
		const archived = await stat(join(mailboxPath(name), 'archive', `${messageId(id)}.md`)).then(
			() => true,
			(statError: unknown) => {
				if (missing(statError)) return false;
				throw statError;
			},
		);
		if (!archived)
			throw new Error(
				`Message ${id} is not in your inbox or archive; this command sent no confirmation.`,
			);
		const confirmed = await optionalText(statePath(name, id, 'confirmed'));
		if (confirmed)
			throw new Error(`Message ${id} is archived and was already confirmed (${confirmed}).`);
		// No record cannot prove none was ever sent: a crash may have come between send and record.
		throw new Error(
			`Message ${id} is archived with no recorded confirmation, and only inbox mail can be confirmed, so this command sent none. Read it with --mail read-history if needed, and tell the sender in a new message if they are waiting on one.`,
		);
	};
}
