import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { atomicWrite, locked, missing, optionalText } from './mail-files.ts';
import { messageId, operatorOnly, ownMailbox } from './mail-identity.ts';
import { assertReadWindow, boundedBytes, header, type MailChunk, statePath } from './mail-read.ts';
import { mailboxPath, sendMessage } from './mailbox.ts';
import { slugFor, storageRoot } from './store.ts';

export interface Hold {
	id: string;
	agent: string;
	messageId: string;
	sender: string;
	reason: string;
	proposal: string;
	digest: string;
	createdAt: string;
	decision: 'pending' | 'approve' | 'decline';
	userReference: string;
}

export interface HoldPage {
	holds: (Hold | { id: string; oversized: true })[];
	next: string | null;
}

export interface HeldMessage {
	hold: Hold;
	instruction: string;
}

function holdPath(name: string, id: string): string {
	ownMailbox(name);
	return join(mailboxPath(name), 'holds', `${messageId(id)}.json`);
}

async function loadHold(name: string, id: string): Promise<Hold> {
	const text = await optionalText(holdPath(name, id));
	const parsed: unknown = text === undefined ? null : JSON.parse(text);
	if (!parsed || typeof parsed !== 'object') throw new Error('Unknown approval hold.');
	const value = parsed as Record<string, unknown>;
	for (const field of [
		'id',
		'agent',
		'messageId',
		'sender',
		'reason',
		'proposal',
		'digest',
		'createdAt',
		'decision',
		'userReference',
	]) {
		if (typeof value[field] !== 'string') throw new Error('Invalid approval hold.');
	}
	if (
		value.id !== id ||
		value.agent !== name ||
		!['pending', 'approve', 'decline'].includes(String(value.decision))
	)
		throw new Error('Invalid approval hold identity.');
	return parsed as Hold;
}

export async function ownHolds(name: string): Promise<Hold[]> {
	const root = join(mailboxPath(name), 'holds');
	ownMailbox(name);
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch (error: unknown) {
		if (missing(error)) return [];
		throw error;
	}
	const holds = [];
	for (const file of entries.filter((file) => file.endsWith('.json')))
		holds.push(await loadHold(name, file.slice(0, -5)));
	return holds;
}

export async function receiveHolds(name: string, cursor = ''): Promise<HoldPage> {
	if (cursor) messageId(cursor);
	const holds = (await ownHolds(name)).sort((a, b) => a.id.localeCompare(b.id));
	const remaining = holds.filter((hold) => hold.id > cursor);
	const page: (Hold | { id: string; oversized: true })[] = [];
	let bytes = 512;
	for (const hold of remaining) {
		if (page.length === 10) break;
		const entry =
			Buffer.byteLength(JSON.stringify(hold)) > 24000
				? { id: hold.id, oversized: true as const }
				: hold;
		const length = Buffer.byteLength(JSON.stringify(entry));
		if (bytes + length > 32768) break;
		page.push(entry);
		bytes += length;
	}
	return { holds: page, next: page.length < remaining.length ? (page.at(-1)?.id ?? null) : null };
}

export async function holdMessage(
	name: string,
	id: string,
	reason: string,
	proposal: string,
): Promise<HeldMessage> {
	if (!reason.trim() || !proposal.trim())
		throw new Error(
			'A hold requires a reason and exact proposed action, including targets and constraints.',
		);
	const mail = await header(name, id);
	if (!(await optionalText(statePath(name, id, 'confirmed'))))
		throw new Error('Assess and confirm the request before holding it.');
	const digest = createHash('sha256')
		.update(JSON.stringify([name, id, reason, proposal]))
		.digest('hex');
	const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
	const path = holdPath(name, uuid);
	return locked(statePath(name, id, 'handling.lock'), () =>
		locked(`${path}.lock`, async () => {
			await header(name, id);
			const exists = await optionalText(path);
			const hold: Hold = exists
				? await loadHold(name, uuid)
				: {
						id: uuid,
						agent: name,
						messageId: id,
						sender: mail.from,
						reason,
						proposal,
						digest,
						createdAt: new Date().toISOString(),
						decision: 'pending',
						userReference: '',
					};
			if (!exists) await atomicWrite(path, JSON.stringify(hold));
			await atomicWrite(resolve(storageRoot(), 'attention', `${uuid}.ref`), name);
			await sendMessage(
				name,
				mail.from,
				`Request ${id} is held for user approval. Hold ${uuid}. Reason: ${reason}`,
				{ kind: 'confirmation', replyTo: id, id: uuid },
			);
			return {
				hold,
				instruction: `${exists ? 'Existing hold. ' : ''}Set summon --status needs-user and immediately post the exact proposed action and concern with summon --room ask --approval. Do not wait for ask me or repost an existing unanswered control. Follow this team's explicit policy for decision reminders. Wait for a direct user decision.`,
			};
		}),
	);
}

export async function readHoldChunk(
	name: string,
	id: string,
	offset: number,
	limit: number,
): Promise<MailChunk> {
	assertReadWindow(offset, limit);
	const text = await optionalText(holdPath(name, id));
	if (text === undefined) throw new Error('Unknown approval hold.');
	await loadHold(name, id);
	const bytes = Buffer.from(text, 'utf8');
	if (offset > bytes.length) throw new Error('Read offset exceeds message size.');
	const window = bytes.subarray(offset, Math.min(bytes.length, offset + limit + 4));
	const { text: chunk, count } = boundedBytes(window, limit);
	return { text: chunk, end: offset + count, size: bytes.length };
}

export async function hasPendingHold(name: string, id: string): Promise<boolean> {
	return (await ownHolds(name)).some(
		(hold) => hold.messageId === id && hold.decision === 'pending',
	);
}

export async function assertNotHeld(name: string, id: string): Promise<void> {
	if (await hasPendingHold(name, id)) {
		throw new Error('This request is held for user approval; leave it pending.');
	}
}

export async function recordDecision(
	name: string,
	id: string,
	decision: string,
	userReference: string,
): Promise<Hold> {
	if (decision !== 'approve' && decision !== 'decline')
		throw new Error('Decision must be approve or decline.');
	if (!userReference.trim()) throw new Error('A direct user decision reference is required.');
	const path = holdPath(name, id);
	return locked(`${path}.lock`, async () => {
		const hold = await loadHold(name, id);
		if (hold.decision !== 'pending') {
			if (hold.decision !== decision)
				throw new Error('This hold already has a different decision.');
			return hold;
		}
		hold.decision = decision;
		hold.userReference = userReference;
		await atomicWrite(path, JSON.stringify(hold));
		return hold;
	});
}

export async function attentionCommand(args: string[]): Promise<void> {
	operatorOnly();
	const [action, id] = args;
	if (action === 'list' && args.length === 1) {
		const root = resolve(storageRoot(), 'attention');
		let entries: string[];
		try {
			entries = await readdir(root);
		} catch (error: unknown) {
			if (missing(error)) {
				console.log('[]');
				return;
			}
			throw error;
		}
		const pending = [];
		for (const file of entries.filter((file) => file.endsWith('.ref'))) {
			const name = slugFor((await optionalText(join(root, file))) ?? '');
			const hold = await loadHold(name, file.slice(0, -4));
			if (hold.decision === 'pending') pending.push(hold);
		}
		console.log(JSON.stringify(pending, null, 2));
		return;
	}
	if ((action === 'approve' || action === 'decline') && id && args.length === 2) {
		const name = slugFor(
			(await optionalText(resolve(storageRoot(), 'attention', `${messageId(id)}.ref`))) ?? '',
		);
		console.log(
			JSON.stringify(
				await recordDecision(
					name,
					id,
					action,
					`operator CLI at ${new Date().toISOString()}`,
				),
			),
		);
		return;
	}
	throw new Error('Usage: summon --attention list|approve <hold-id>|decline <hold-id>');
}
