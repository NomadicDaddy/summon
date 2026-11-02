import { link, mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { errorCode, locked, missing, optionalText } from './mail-files.ts';
import { sameMailContent } from './mail-replay.ts';

export class MailArchiveConflictError extends Error {
	constructor(inbox: string, archive: string) {
		super(`Mail archive identity conflict; both messages preserved: ${inbox} and ${archive}`);
		this.name = 'MailArchiveConflictError';
	}
}

/** Publishers only add inbox names; every acknowledgement serializes their removal here. */
export async function archiveMessage(root: string, id: string): Promise<void> {
	await locked(join(root, 'acks', `${id}.lock`), async () => {
		const inbox = join(root, 'inbox', `${id}.md`);
		const archive = join(root, 'archive', `${id}.md`);
		await mkdir(join(root, 'archive'), { recursive: true, mode: 0o700 });
		try {
			// Unlike rename, link cannot replace an already archived message.
			await link(inbox, archive);
		} catch (error: unknown) {
			if (missing(error)) {
				// A previous acknowledgement may already have removed the inbox name.
				await readFile(archive);
				return;
			}
			if (errorCode(error) !== 'EEXIST') throw error;
			const [pending, retained] = await Promise.all([
				optionalText(inbox),
				readFile(archive, 'utf8'),
			]);
			// Some filesystems may report the existing target before the missing source.
			if (pending === undefined) return;
			if (!sameMailContent(pending, retained))
				throw new MailArchiveConflictError(inbox, archive);
		}
		// A crash before this unlink leaves both names; the comparison above converges next time.
		await unlink(inbox);
	});
}
