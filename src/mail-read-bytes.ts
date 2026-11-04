import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { coveringInbox, messageId, ownMailbox } from './mail-identity.ts';
import { mailboxPath } from './mailbox.ts';

export interface MailChunk {
	text: string;
	end: number;
	size: number;
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
