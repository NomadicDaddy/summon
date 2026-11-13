import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { MailChunk } from './mail-read-bytes.ts';
import type { SystemMail, SystemMailStatus } from './system-mail.ts';

import { missing } from './mail-files.ts';
import { messageId, ownMailbox } from './mail-identity.ts';
import { readChunk } from './mail-read-bytes.ts';
import { mailboxPath, pendingMessages } from './mailbox.ts';
import { slugFor } from './store.ts';
import { decodeSystemMail, systemMailStatus } from './system-mail.ts';

export interface MailHeader {
	id: string;
	from: string;
	to: string;
	sent: string;
	kind: string;
	size: number;
	systemNotice?: SystemMail;
	noticeStatus?: SystemMailStatus;
}

export function statePath(name: string, id: string, state: string): string {
	ownMailbox(name);
	return join(mailboxPath(name), 'delivery', `${messageId(id)}.${state}`);
}

export async function header(name: string, id: string, archive = false): Promise<MailHeader> {
	const { text, size } = await readChunk(name, id, 0, 2048, archive);
	const boundary = text.indexOf('\n\n');
	if (boundary < 0) throw new Error(`Malformed message header: ${id}`);
	const fields = new Map(
		text
			.slice(0, boundary)
			.split('\n')
			.map((line) => {
				const colon = line.indexOf(': ');
				return [line.slice(0, colon), line.slice(colon + 2)];
			}),
	);
	const from = slugFor(fields.get('From') ?? '');
	const to = slugFor(fields.get('To') ?? '');
	const sent = fields.get('Sent') ?? '';
	if (fields.get('ID') !== id || to !== slugFor(name) || !Number.isFinite(Date.parse(sent))) {
		throw new Error(`Malformed message metadata: ${id}`);
	}
	const kind = fields.get('Kind') ?? 'request';
	const generated = fields.get('Summon-Notice');
	if (generated === undefined) return { id, from, to, sent, size, kind };
	if (kind !== 'notice' || from !== to) throw new Error(`Malformed generated notice: ${id}`);
	let systemNotice: SystemMail;
	try {
		systemNotice = decodeSystemMail(generated);
	} catch {
		// Version-skewed provenance cannot justify suppressing this or unrelated mail.
		return { id, from, to, sent, size, kind, noticeStatus: 'unverifiable' };
	}
	return {
		id,
		from,
		to,
		sent,
		size,
		kind,
		systemNotice,
		noticeStatus: await systemMailStatus(to, systemNotice),
	};
}

/** A listed inbox entry may move to the archive before its header is opened. */
export async function readListedMail(name: string, files: string[], archive = false) {
	if (archive) ownMailbox(name);
	const mails: MailHeader[] = [];
	const errors: { id: string; error: string }[] = [];
	for (const file of files.filter((entry) => entry.endsWith('.md'))) {
		const id = file.slice(0, -3);
		try {
			mails.push(await header(name, id, archive));
		} catch (error: unknown) {
			let problem = error;
			if (!archive && missing(error)) {
				try {
					await header(name, id, true);
					continue;
				} catch (archiveError: unknown) {
					if (!missing(archiveError)) problem = archiveError;
				}
			}
			if (errors.length < 10)
				errors.push({
					id,
					error: (problem instanceof Error ? problem.message : String(problem)).slice(
						0,
						256,
					),
				});
		}
	}
	return { mails, errors };
}

export async function readMailIndex(name: string, archive = false) {
	if (archive) ownMailbox(name);
	const files = archive
		? await readdir(join(mailboxPath(name), 'archive')).catch((error: unknown) => {
				if (missing(error)) return [];
				throw error;
			})
		: await pendingMessages(name);
	return readListedMail(name, files, archive);
}

/** Finish a previously indexed inbox read after a concurrent archive move. */
export async function readIndexedChunk(
	name: string,
	mail: MailHeader,
	offset = 0,
	limit = 32768,
): Promise<MailChunk> {
	try {
		return await readChunk(name, mail.id, offset, limit);
	} catch (error: unknown) {
		if (!missing(error)) throw error;
		ownMailbox(name);
		const archived = await header(name, mail.id, true);
		if (
			archived.from !== mail.from ||
			archived.to !== mail.to ||
			archived.sent !== mail.sent ||
			archived.kind !== mail.kind ||
			archived.size !== mail.size
		)
			throw new Error(`Archived mail changed after inbox indexing: ${mail.id}`, {
				cause: error,
			});
		return readChunk(name, mail.id, offset, limit, true);
	}
}
