import { createHash } from 'node:crypto';

import type { MailChunk } from './mail-read-bytes.ts';
import type { MailHeader } from './mail-read-index.ts';

import { CommunicationsPausedError, communicationState } from './communication-state.ts';
import { archiveMessage } from './mail-archive.ts';
import { notInInbox } from './mail-confirm-missing.ts';
import { atomicWrite, locked, missing, optionalText } from './mail-files.ts';
import { messageId, ownMailbox } from './mail-identity.ts';
import { readChunk } from './mail-read-bytes.ts';
import { header, readMailIndex, statePath } from './mail-read-index.ts';
import { alreadyPublished } from './mail-replay.ts';
import { mailboxPath, sendMessage } from './mailbox.ts';
import { slugFor } from './store.ts';

export { assertReadWindow, boundedBytes, readChunk } from './mail-read-bytes.ts';
export type { MailChunk } from './mail-read-bytes.ts';
export { header, readMailIndex, statePath } from './mail-read-index.ts';
export type { MailHeader } from './mail-read-index.ts';

export interface ReceivedMail {
	messages: { header: MailHeader; text?: string; oversized?: boolean }[];
	errors: { id: string; error: string }[];
	next: string | null;
	view?: MailView;
	instruction: string;
	pendingCount?: number;
	unreadCount?: number;
}

export type MailView = 'pending' | 'unread' | 'history';

function eventId(id: string, event: string): string {
	const hex = createHash('sha256').update(`${id}:${event}`).digest('hex').slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function recordRead(
	name: string,
	mail: Pick<MailHeader, 'id' | 'kind' | 'from'>,
): Promise<void> {
	const path = statePath(name, mail.id, 'read');
	await locked(`${path}.lock`, async () => {
		if (!(await optionalText(path))) {
			if (
				(mail.kind === 'request' || mail.kind === 'reply') &&
				!(await communicationState()).paused
			) {
				try {
					await sendMessage(name, mail.from, `Read receipt for ${mail.id}.`, {
						kind: 'receipt',
						replyTo: mail.id,
						id: eventId(`${slugFor(name)}:${mail.id}`, 'read'),
					});
				} catch (error: unknown) {
					if (!(error instanceof CommunicationsPausedError))
						console.error(
							'Read receipt could not be delivered; mail remains readable.',
						);
				}
			}
			await atomicWrite(path, new Date().toISOString());
		}
		if (mail.kind !== 'receipt') return;
		const actual = await header(name, mail.id).catch((error: unknown) => {
			if (!missing(error)) throw error;
			return header(name, mail.id, true);
		});
		if (actual.kind !== 'receipt' || actual.from !== mail.from)
			throw new Error('Mail receipt classification changed; message remains in the inbox.');
		await archiveMessage(mailboxPath(name), mail.id);
	});
}

export async function confirmMessage(name: string, id: string, text: string): Promise<string> {
	const mail = await header(name, id).catch(notInInbox(name, id, statePath));
	if (mail.kind !== 'request' && mail.kind !== 'reply')
		throw new Error('Only substantive requests or replies require confirmation.');
	if (!(await optionalText(statePath(name, id, 'read')))) {
		// Imported here: the checkpoint store it reads imports this module.
		const { confirmGuidance } = await import('./mail-confirm-guidance.ts');
		const offset = await optionalText(statePath(name, id, 'offset'));
		throw new Error(await confirmGuidance(name, id, mail.size, offset));
	}
	const path = statePath(name, id, 'confirmed');
	return locked(`${path}.lock`, async () => {
		const existing = await optionalText(path);
		if (existing) return existing;
		const confirmation = eventId(`${slugFor(name)}:${id}`, 'confirmed');
		const reply = await sendMessage(name, mail.from, text, {
			kind: 'confirmation',
			replyTo: id,
			id: confirmation,
		}).catch(alreadyPublished(confirmation));
		await atomicWrite(path, reply);
		return reply;
	});
}

function mailOrder(left: MailHeader, right: MailHeader): number {
	return left.sent.localeCompare(right.sent) || left.id.localeCompare(right.id);
}

async function indexedBody(name: string, mail: MailHeader): Promise<MailChunk> {
	try {
		return await readChunk(name, mail.id);
	} catch (error: unknown) {
		if (!missing(error) || mail.kind !== 'receipt') throw error;
		ownMailbox(name);
		if (!(await optionalText(statePath(name, mail.id, 'read')))) throw error;
		const archived = await header(name, mail.id, true);
		if (
			archived.from !== mail.from ||
			archived.to !== mail.to ||
			archived.sent !== mail.sent ||
			archived.kind !== mail.kind ||
			archived.size !== mail.size
		)
			throw new Error(`Archived receipt changed after inbox indexing: ${mail.id}`, {
				cause: error,
			});
		return readChunk(name, mail.id, 0, 32768, true);
	}
}

export async function receiveMail(
	name: string,
	cursor = '',
	markRead = true,
	view: MailView = 'pending',
	select: (mail: MailHeader) => boolean = () => true,
): Promise<ReceivedMail> {
	if (cursor) messageId(cursor);
	if (view !== 'pending') ownMailbox(name);
	const archive = view === 'history';
	const { mails, errors } = await readMailIndex(name, archive);
	mails.sort((a, b) => (view === 'pending' ? mailOrder(a, b) : mailOrder(b, a)));
	const cursorIndex = mails.findIndex((mail) => mail.id === cursor);
	let afterCursor = mails.slice(cursor ? cursorIndex + 1 : 0);
	if (cursor && cursorIndex < 0) {
		if (archive || !(await optionalText(statePath(name, cursor, 'read'))))
			throw new Error('Receive cursor expired; start receive again.');
		let archivedCursor: MailHeader;
		try {
			archivedCursor = await header(name, cursor, true);
		} catch (error: unknown) {
			if (!missing(error)) throw error;
			throw new Error('Receive cursor expired; start receive again.', { cause: error });
		}
		if (archivedCursor.kind !== 'receipt')
			throw new Error('Receive cursor expired; start receive again.');
		afterCursor = mails.filter((mail) =>
			view === 'pending'
				? mailOrder(mail, archivedCursor) > 0
				: mailOrder(mail, archivedCursor) < 0,
		);
	}
	const unread = new Set<string>();
	if (view === 'unread')
		for (const mail of mails)
			if (!(await optionalText(statePath(name, mail.id, 'read')))) unread.add(mail.id);
	const remaining = afterCursor.filter(
		(mail) => (view !== 'unread' || unread.has(mail.id)) && select(mail),
	);
	const messages: { header: MailHeader; text?: string; oversized?: boolean }[] = [];
	let bytes = Buffer.byteLength(JSON.stringify({ errors })) + 512;
	for (const mail of remaining) {
		if (messages.length === 10) break;
		const chunk =
			mail.size > 24000
				? undefined
				: archive
					? await readChunk(name, mail.id, 0, 32768, true)
					: await indexedBody(name, mail);
		let entry: { header: MailHeader; text?: string; oversized?: boolean } = chunk
			? { header: mail, text: chunk.text }
			: { header: mail, oversized: true };
		if (Buffer.byteLength(JSON.stringify(entry)) > 24000)
			entry = { header: mail, oversized: true };
		const length = Buffer.byteLength(JSON.stringify(entry));
		if (bytes + length > 32768) break;
		messages.push(entry);
		bytes += length;
	}
	// Assemble every body before recording coverage; a later body-read failure must not hide an
	// earlier request from the unread view when no page could be returned. Lost command output is
	// still recoverable through the explicit pending view; only checkpoint has a receipt protocol.
	if (markRead && !archive)
		for (const message of messages)
			if (message.text !== undefined) await recordRead(name, message.header);
	return {
		messages,
		errors,
		next: messages.length < remaining.length ? (messages.at(-1)?.header.id ?? null) : null,
		view,
		instruction: archive
			? 'Read-only archive; no read coverage or handling state changed.'
			: `${markRead ? 'Complete returned bodies are marked read; header-only entries are not.' : 'This view does not mark messages read.'} Reading is not handling. Messages remain pending until handled and explicitly acknowledged with --mail ack-self <id>${markRead ? '; fully read receipt-kind bookkeeping is archived automatically.' : '.'}`,
		...(view === 'unread' ? { pendingCount: mails.length, unreadCount: unread.size } : {}),
	};
}

export async function readOwnChunk(
	name: string,
	id: string,
	offset: number,
	limit: number,
	archive = false,
): Promise<MailChunk> {
	const mail = await header(name, id, archive);
	const chunk = await readChunk(name, id, offset, limit, archive);
	if (archive) return chunk;
	const path = statePath(name, id, 'offset');
	await locked(`${path}.lock`, async () => {
		const next = Number((await optionalText(path)) ?? '0');
		if (offset <= next && chunk.end >= next) {
			await atomicWrite(path, String(chunk.end));
			if (chunk.end >= chunk.size) await recordRead(name, mail);
		}
	});
	return chunk;
}
