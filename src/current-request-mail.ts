import type { CheckpointInput } from './checkpoint-package-pages.ts';
import type { MailHeader } from './mail-read.ts';

import { missing, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { header, readChunk, readMailIndex, statePath } from './mail-read.ts';

async function completeMail(name: string, mail: MailHeader, archive = false): Promise<string> {
	let text = '';
	for (let offset = 0; offset < mail.size;) {
		const chunk = await readChunk(name, mail.id, offset, 32768, archive);
		if (chunk.size !== mail.size || chunk.end <= offset)
			throw new Error(
				'Current mail changed during reading. Restart the focused read; no receipt was changed.',
			);
		text += chunk.text;
		offset = chunk.end;
	}
	return text;
}

async function ownContext(
	name: string,
	id: string,
): Promise<{ mail: MailHeader; text: string } | undefined> {
	let mail: MailHeader | undefined;
	let archive = false;
	try {
		mail = await header(name, id);
	} catch (error: unknown) {
		if (!missing(error)) throw error;
		archive = true;
		try {
			mail = await header(name, id, true);
		} catch (nested: unknown) {
			if (!missing(nested)) throw nested;
		}
	}
	return mail ? { mail, text: await completeMail(name, mail, archive) } : undefined;
}

/** Complete bodies and available ancestry only from this name's inbox and archive. */
export async function currentMailInputs(
	name: string,
	capturedAt: string,
): Promise<CheckpointInput[]> {
	ownMailbox(name);
	const index = await readMailIndex(name);
	if (index.errors.length)
		throw new Error(
			'Own mail inventory is invalid; inspect summon --mail receive before reading current requests.',
		);
	const inputs: CheckpointInput[] = [];
	const seen = new Set<string>();
	for (const mail of index.mails.toSorted(
		(a, b) => Date.parse(b.sent) - Date.parse(a.sent) || b.id.localeCompare(a.id),
	)) {
		if (
			Date.parse(mail.sent) > Date.parse(capturedAt) ||
			['receipt', 'confirmation', 'rest-ready'].includes(mail.kind) ||
			mail.noticeStatus === 'obsolete' ||
			(await optionalText(statePath(name, mail.id, 'read'))) ||
			seen.has(mail.id)
		)
			continue;
		let current: { mail: MailHeader; text: string } | undefined = {
			mail,
			text: await completeMail(name, mail),
		};
		while (current && !seen.has(current.mail.id)) {
			const { mail: item, text } = current;
			seen.add(item.id);
			inputs.push({
				source: 'mail',
				id: item.id,
				forMe: item.id === mail.id,
				presentation: 'exact',
				value: { header: item, text },
			});
			const headers = text.slice(0, text.indexOf('\n\n'));
			const parent = /^In-Reply-To: ([0-9a-f-]{36})$/m.exec(headers)?.[1];
			if (!parent || seen.has(parent)) break;
			current = await ownContext(name, parent);
			if (!current)
				inputs.push({
					source: 'mail-error',
					id: parent,
					forMe: false,
					presentation: 'exact',
					value: {
						id: parent,
						error: 'Linked reply context is unavailable in your own inbox/archive. Ask the sender or use your own records before acting; never inspect another mailbox.',
					},
				});
		}
	}
	return inputs;
}
