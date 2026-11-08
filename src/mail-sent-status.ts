import { createHash } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWrite, locked, missing, optionalText } from './mail-files.ts';
import { messageId, ownMailbox } from './mail-identity.ts';
import { header } from './mail-read-index.ts';
import { mailboxPath, sendMessage } from './mailbox.ts';
import { slugFor } from './store.ts';

interface SentRecord {
	id: string;
	to: string | null;
	published: boolean;
	readAt: string | null;
}

interface PendingRead {
	id: string;
	from: string;
	kind: string;
	readAt: string;
}

function legacyReceiptId(to: string, id: string): string {
	const hex = createHash('sha256').update(`${to}:${id}:read`).digest('hex').slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const sentPath = (name: string, id: string): string =>
	join(mailboxPath(name), 'sent-status', `${messageId(id)}.json`);
const pendingPath = (name: string, id: string): string =>
	join(mailboxPath(name), 'delivery', 'pending-read', `${messageId(id)}.json`);

function parseSent(text: string, id: string): SentRecord {
	const value: unknown = JSON.parse(text);
	if (
		!value ||
		typeof value !== 'object' ||
		!('id' in value) ||
		value.id !== id ||
		!('to' in value) ||
		(value.to !== null && typeof value.to !== 'string') ||
		!('published' in value) ||
		typeof value.published !== 'boolean' ||
		!('readAt' in value) ||
		(value.readAt !== null &&
			(typeof value.readAt !== 'string' || !Number.isFinite(Date.parse(value.readAt))))
	)
		throw new Error('Invalid sender read-status record.');
	return value as SentRecord;
}

function parsePending(text: string, id: string): PendingRead {
	const value: unknown = JSON.parse(text);
	if (
		!value ||
		typeof value !== 'object' ||
		!('id' in value) ||
		value.id !== id ||
		!('from' in value) ||
		typeof value.from !== 'string' ||
		!('kind' in value) ||
		typeof value.kind !== 'string' ||
		!('readAt' in value) ||
		typeof value.readAt !== 'string' ||
		!Number.isFinite(Date.parse(value.readAt))
	)
		throw new Error('Invalid pending read-status record.');
	return value as PendingRead;
}

/** Prepare before publication; a failed send remains unknown, never falsely reported as sent. */
export async function prepareSentStatus(from: string, to: string, id: string): Promise<void> {
	const sender = slugFor(from);
	const recipient = slugFor(to);
	const path = sentPath(sender, id);
	await locked(`${path}.lock`, async () => {
		const previous = await optionalText(path);
		if (previous) {
			const record = parseSent(previous, id);
			if (record.to !== recipient)
				throw new Error('Mail ID already belongs to another recipient.');
			return;
		}
		await atomicWrite(
			path,
			JSON.stringify({ id, to: recipient, published: false, readAt: null }),
		);
	});
}

/** A status-write failure cannot make a published message look undelivered to its caller. */
export async function markSentPublished(from: string, id: string): Promise<void> {
	const path = sentPath(from, id);
	await locked(`${path}.lock`, async () => {
		const text = await optionalText(path);
		if (!text) throw new Error('Missing sender read-status record after publication.');
		const record = parseSent(text, id);
		if (!record.published)
			await atomicWrite(path, JSON.stringify({ ...record, published: true }));
	});
}

export async function sentStatus(name: string, id: string) {
	ownMailbox(name);
	const text = await optionalText(sentPath(name, id));
	if (!text) return { id, status: 'unknown' as const, readAt: null };
	const record = parseSent(text, id);
	if (record.to === null) return { id, status: 'unknown' as const, readAt: null };
	if (record.readAt) return { id, status: 'recorded-read' as const, readAt: record.readAt };
	return {
		id,
		status: record.published ? ('unconfirmed' as const) : ('unknown' as const),
		readAt: null,
	};
}

/** Internal read-path write only: a recipient cannot query the sender's private projection. */
async function projectRead(
	to: string,
	pending: PendingRead,
): Promise<'projected' | 'legacy' | 'ambiguous'> {
	const path = sentPath(pending.from, pending.id);
	return locked(`${path}.lock`, async () => {
		const text = await optionalText(path);
		if (!text) return 'legacy';
		const record = parseSent(text, pending.id);
		if (record.to === null) return 'ambiguous';
		if (record.to !== slugFor(to)) throw new Error('Sender read-status recipient mismatch.');
		if (!record.readAt)
			await atomicWrite(
				path,
				JSON.stringify({ ...record, published: true, readAt: pending.readAt }),
			);
		return 'projected';
	});
}

export async function queueReadProjection(
	to: string,
	from: string,
	id: string,
	kind: string,
): Promise<void> {
	ownMailbox(to);
	const pending: PendingRead = {
		id: messageId(id),
		from: slugFor(from),
		kind,
		readAt: new Date().toISOString(),
	};
	const path = pendingPath(to, id);
	await locked(`${path}.lock`, async () => {
		const previous = await optionalText(path);
		if (previous) {
			const existing = parsePending(previous, id);
			if (existing.from !== pending.from || existing.kind !== pending.kind)
				throw new Error('Pending read-status sender mismatch.');
			return;
		}
		await atomicWrite(path, JSON.stringify(pending));
	});
}

export async function finishReadProjection(to: string, id: string): Promise<void> {
	ownMailbox(to);
	const path = pendingPath(to, id);
	await locked(`${path}.lock`, async () => {
		const text = await optionalText(path);
		if (!text) return;
		const pending = parsePending(text, id);
		const actual = await header(to, id).catch((error: unknown) => {
			if (!missing(error)) throw error;
			return header(to, id, true);
		});
		if (actual.from !== pending.from || actual.kind !== pending.kind)
			throw new Error('Pending read status does not match the retained mail.');
		const readPath = join(mailboxPath(to), 'delivery', `${id}.read`);
		await locked(`${readPath}.lock`, async () => {
			if (!(await optionalText(readPath))) await atomicWrite(readPath, pending.readAt);
		});
		const projected = await projectRead(to, pending);
		if (projected === 'legacy' && (pending.kind === 'request' || pending.kind === 'reply'))
			await sendMessage(to, pending.from, `Read receipt for ${id}.`, {
				kind: 'receipt',
				replyTo: id,
				id: legacyReceiptId(to, id),
			});
		await unlink(path).catch((error: unknown) => {
			if (!missing(error)) throw error;
		});
	});
}

/** Retry only the receiver's own finite pending journal, including after a restart. */
export async function recoverReadProjections(name: string): Promise<void> {
	ownMailbox(name);
	const dir = join(mailboxPath(name), 'delivery', 'pending-read');
	const files = await readdir(dir).catch((error: unknown): string[] => {
		if (missing(error)) return [];
		throw error;
	});
	for (const file of files) {
		if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/.test(file)) continue;
		try {
			await finishReadProjection(name, file.slice(0, -5));
		} catch {
			// Keep the journal for the next owned read or checkpoint after transient failure.
		}
	}
}
