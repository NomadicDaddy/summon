import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { missing } from '../mail-files.ts';
import { operatorOnly } from '../mail-identity.ts';
import { mailboxPath } from '../mailbox.ts';

/** Operator-only counts; never returns message names or opens message bodies. */
export async function unreadMailCount(name: string): Promise<number> {
	operatorOnly();
	const entries = async (folder: string): Promise<string[]> => {
		try {
			return await readdir(join(mailboxPath(name), folder));
		} catch (error: unknown) {
			if (missing(error)) return [];
			throw error;
		}
	};
	const [inbox, delivery] = await Promise.all([entries('inbox'), entries('delivery')]);
	const read = new Set(
		delivery.filter((file) => file.endsWith('.read')).map((file) => file.slice(0, -5)),
	);
	return inbox.filter((file) => file.endsWith('.md') && !read.has(file.slice(0, -3))).length;
}
