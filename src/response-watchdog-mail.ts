import type { WakeTarget } from './wake-part.ts';

import { optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { header, statePath } from './mail-read.ts';
import { pendingMessages } from './mailbox.ts';

/** Bounded concurrency; already-read mail needs no header/body read or retained target. */
export async function responseMailInventory(name: string) {
	ownMailbox(name);
	const files = await pendingMessages(name);
	const targets: WakeTarget[] = [];
	let failed = false;
	for (let offset = 0; offset < files.length; offset += 16) {
		const batch = await Promise.all(
			files.slice(offset, offset + 16).map(async (file) => {
				const id = file.slice(0, -3);
				try {
					if (await optionalText(statePath(name, id, 'read'))) return undefined;
					const mail = await header(name, id);
					if (
						mail.kind === 'receipt' ||
						mail.kind === 'confirmation' ||
						mail.kind === 'rest-ready' ||
						mail.noticeStatus === 'obsolete'
					)
						return undefined;
					return {
						source: 'mail',
						key: 'inbox',
						through: 0,
						ids: [id],
					} satisfies WakeTarget;
				} catch {
					failed = true;
					return undefined;
				}
			}),
		);
		for (const target of batch) if (target) targets.push(target);
		if (targets.length > 10000) throw new Error('Response mail inventory exceeds its bound.');
	}
	return { targets, failed };
}
