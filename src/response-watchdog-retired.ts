import type { WakeTarget } from './wake-part.ts';

import { missing } from './mail-files.ts';
import { messageId, ownMailbox } from './mail-identity.ts';
import { header } from './mail-read.ts';

/** An explicit archive ends pending work; it does not manufacture a read marker. */
export async function responseTargetRetired(name: string, target: WakeTarget): Promise<boolean> {
	ownMailbox(name);
	if (target.source !== 'mail' || !target.ids.length) return false;
	for (const id of target.ids) {
		messageId(id);
		try {
			const mail = await header(name, id);
			// Transport acknowledgements are not work, including previously retained targets.
			if (['receipt', 'confirmation', 'rest-ready'].includes(mail.kind)) continue;
			return false;
		} catch (error: unknown) {
			if (!missing(error)) throw error;
		}
		try {
			await header(name, id, true);
		} catch (error: unknown) {
			if (!missing(error)) throw error;
			return false;
		}
	}
	return true;
}
