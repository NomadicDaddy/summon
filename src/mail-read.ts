import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { SystemMail, SystemMailStatus } from './system-mail.ts';

import { CommunicationsPausedError, communicationState } from './communication-state.ts';
import { notInInbox } from './mail-confirm-missing.ts';
import { atomicWrite, locked, missing, optionalText } from './mail-files.ts';
import { coveringInbox, messageId, ownMailbox } from './mail-identity.ts';
import { alreadyPublished } from './mail-replay.ts';
import { mailboxPath, pendingMessages, sendMessage } from './mailbox.ts';
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

export interface MailChunk {
	text: string;
	end: number;
	size: number;
}

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

export function statePath(name: string, id: string, state: string): string {
	ownMailbox(name);
	return join(mailboxPath(name), 'delivery', `${messageId(id)}.${state}`);
}

export function assertReadWindow(offset: number, limit: number): void {
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 32768
	) {
		throw new Error('Read offset must be nonnegative; limit must be 1 through 32768 bytes.');
	}
}

/** Returns the longest valid UTF-8 prefix of buffer that fits in limit. */
export function boundedBytes(buffer: Buffer, limit: number): { text: string; count: number } {
	const bytesRead = buffer.length;
	if (bytesRead && ((buffer[0] ?? 0) & 0xc0) === 0x80)
		throw new Error('Read offset splits a UTF-8 character; use the previous chunk end.');
	let count = Math.min(limit, bytesRead);
	while (count < bytesRead && ((buffer[count] ?? 0) & 0xc0) === 0x80) count -= 1;
	if (bytesRead && !count) throw new Error('Limit is too small for the next UTF-8 character.');
	return { text: buffer.subarray(0, count).toString('utf8'), count };
}

export async function readChunk(
	name: string,
	id: string,
	offset = 0,
	limit = 32768,
	archive = false,
): Promise<MailChunk> {
	// Readable by the owner, or by whoever is recorded as covering them.
	if (archive) ownMailbox(name);
	else await coveringInbox(name);
	assertReadWindow(offset, limit);
	const file = await open(
		join(mailboxPath(name), archive ? 'archive' : 'inbox', `${messageId(id)}.md`),
		'r',
	);
	try {
		const { size } = await file.stat();
		if (offset > size) throw new Error('Read offset exceeds message size.');
		const buffer = Buffer.alloc(limit + 4);
		const { bytesRead } = await file.read(buffer, 0, limit + 4, offset);
		const { text, count } = boundedBytes(buffer.subarray(0, bytesRead), limit);
		return { text, end: offset + count, size };
	} finally {
		await file.close();
	}
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
		if (await optionalText(path)) return;
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
					console.error('Read receipt could not be delivered; mail remains readable.');
			}
		}
		await atomicWrite(path, new Date().toISOString());
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

export async function readMailIndex(name: string, archive = false) {
	if (archive) ownMailbox(name);
	const files = archive
		? await readdir(join(mailboxPath(name), 'archive')).catch((error: unknown) => {
				if (missing(error)) return [];
				throw error;
			})
		: await pendingMessages(name);
	const mails: MailHeader[] = [];
	const errors: { id: string; error: string }[] = [];
	for (const file of files.filter((entry) => entry.endsWith('.md'))) {
		const id = file.slice(0, -3);
		try {
			mails.push(await header(name, id, archive));
		} catch (error: unknown) {
			if (errors.length < 10)
				errors.push({
					id,
					error: (error instanceof Error ? error.message : String(error)).slice(0, 256),
				});
		}
	}
	return { mails, errors };
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
	mails.sort((a, b) => {
		const order = a.sent.localeCompare(b.sent) || a.id.localeCompare(b.id);
		return view === 'pending' ? order : -order;
	});
	const cursorIndex = mails.findIndex((mail) => mail.id === cursor);
	if (cursor && cursorIndex < 0) throw new Error('Receive cursor expired; start receive again.');
	const unread = new Set<string>();
	if (view === 'unread')
		for (const mail of mails)
			if (!(await optionalText(statePath(name, mail.id, 'read')))) unread.add(mail.id);
	const remaining = mails
		.slice(cursor ? cursorIndex + 1 : 0)
		.filter((mail) => (view !== 'unread' || unread.has(mail.id)) && select(mail));
	const messages: { header: MailHeader; text?: string; oversized?: boolean }[] = [];
	let bytes = Buffer.byteLength(JSON.stringify({ errors })) + 512;
	for (const mail of remaining) {
		if (messages.length === 10) break;
		const chunk =
			mail.size > 24000 ? undefined : await readChunk(name, mail.id, 0, 32768, archive);
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
			: `${markRead ? 'Complete returned bodies are marked read; header-only entries are not.' : 'This view does not mark messages read.'} Reading is not handling. Messages remain pending until handled and explicitly acknowledged with --mail ack-self <id>.`,
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
