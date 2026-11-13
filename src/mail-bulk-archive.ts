import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { archiveMessage } from './mail-archive.ts';
import { ownHolds } from './mail-attention.ts';
import { locked, missing, optionalText } from './mail-files.ts';
import { messageId, ownMailbox } from './mail-identity.ts';
import { header, statePath } from './mail-read-index.ts';
import { mailboxPath, pendingMessages } from './mailbox.ts';

const PAGE_SIZE = 20;
const TOKEN_LIMIT = 8192;

interface Candidate {
	id: string;
	sha256: string;
	readSha256: string;
}

interface Plan {
	version: 1;
	owner: string;
	candidates: Candidate[];
}

interface Row {
	id: string;
	kind: string;
	read: boolean;
	confirmed: boolean;
	held: boolean;
	disposition: 'ARCHIVE' | 'KEEP';
	reason: string;
}

function digest(body: Uint8Array): string {
	return createHash('sha256').update(body).digest('hex');
}

async function safeDirectories(root: string): Promise<void> {
	const required = new Set([dirname(root), root, join(root, 'inbox')]);
	for (const path of [
		dirname(root),
		root,
		join(root, 'inbox'),
		join(root, 'archive'),
		join(root, 'acks'),
		join(root, 'delivery'),
		join(root, 'holds'),
	]) {
		const info = await lstat(path).catch((error: unknown) => {
			if (missing(error) && !required.has(path)) return null;
			throw error;
		});
		if (info && (!info.isDirectory() || info.isSymbolicLink()))
			throw new Error('Mailbox path is not an ordinary directory.');
	}
}

async function marker(owner: string, id: string, state: string): Promise<string | undefined> {
	const path = statePath(owner, id, state);
	const info = await lstat(path).catch((error: unknown) => {
		if (missing(error)) return null;
		throw error;
	});
	if (!info) return undefined;
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
		throw new Error(`Mail marker identity is unverified: ${id}`);
	return optionalText(path);
}

async function inspect(
	owner: string,
	id: string,
	held: boolean,
): Promise<{ row: Row; candidate?: Candidate }> {
	const root = mailboxPath(owner);
	const mail = await header(owner, id);
	const [read, confirmed] = await Promise.all([
		marker(owner, id, 'read'),
		marker(owner, id, 'confirmed'),
	]);
	let reason = 'unresolved-kind';
	if (held) reason = 'hold-evidence';
	else if (mail.kind === 'receipt' && !read) reason = 'receipt-unread';
	else if (mail.kind === 'receipt' && confirmed) reason = 'receipt-confirmation-uncertain';
	else if (mail.kind === 'receipt') reason = 'read-receipt';
	else if (mail.kind === 'request' || mail.kind === 'reply')
		reason = confirmed ? 'confirmation-is-not-handling' : 'substantive-unresolved';
	const row: Row = {
		id,
		kind: mail.kind,
		read: Boolean(read),
		confirmed: Boolean(confirmed),
		held,
		disposition: reason === 'read-receipt' ? 'ARCHIVE' : 'KEEP',
		reason,
	};
	if (row.disposition === 'KEEP') return { row };
	const retained = join(root, 'archive', `${id}.md`);
	if (
		await lstat(retained).catch((error: unknown) => {
			if (missing(error)) return null;
			throw error;
		})
	) {
		row.disposition = 'KEEP';
		row.reason = 'archive-target-present';
		return { row };
	}
	const path = join(root, 'inbox', `${id}.md`);
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
		throw new Error(`Mail identity is not an ordinary single-link file: ${id}`);
	const body = await readFile(path);
	return {
		row,
		candidate: { id, sha256: digest(body), readSha256: digest(Buffer.from(read ?? '')) },
	};
}

function decodePlan(token: string, owner: string): Plan {
	if (token.length > TOKEN_LIMIT || !/^[A-Za-z0-9_-]+$/.test(token))
		throw new Error('Invalid bulk archive plan.');
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
	} catch {
		throw new Error('Invalid bulk archive plan.');
	}
	if (!value || typeof value !== 'object') throw new Error('Invalid bulk archive plan.');
	const plan = value as Partial<Plan>;
	if (
		plan.version !== 1 ||
		plan.owner !== owner ||
		!Array.isArray(plan.candidates) ||
		plan.candidates.length < 1 ||
		plan.candidates.length > PAGE_SIZE ||
		(plan.candidates as unknown[]).some((entry) => {
			if (!entry || typeof entry !== 'object') return true;
			const candidate = entry as Record<string, unknown>;
			return (
				typeof candidate.id !== 'string' ||
				typeof candidate.sha256 !== 'string' ||
				!/^[a-f0-9]{64}$/.test(candidate.sha256) ||
				typeof candidate.readSha256 !== 'string' ||
				!/^[a-f0-9]{64}$/.test(candidate.readSha256)
			);
		})
	)
		throw new Error('Invalid bulk archive plan.');
	const ids = plan.candidates.map((entry) => messageId(entry.id));
	if (new Set(ids).size !== ids.length) throw new Error('Duplicate bulk archive ID.');
	return plan as Plan;
}

/** A bounded own-inbox page. This does not mark mail read or handle requests. */
export async function previewBulkArchive(owner: string, after = '') {
	ownMailbox(owner);
	if (after) messageId(after);
	const root = mailboxPath(owner);
	await safeDirectories(root);
	const files = (await pendingMessages(owner)).filter((file) => /^[a-f0-9-]{36}\.md$/.test(file));
	const remaining = files.filter((file) => file.slice(0, -3) > after);
	const page = remaining.slice(0, PAGE_SIZE);
	const holds = new Set((await ownHolds(owner)).map((hold) => hold.messageId));
	const rows: Row[] = [];
	const candidates: Candidate[] = [];
	for (const file of page) {
		const id = messageId(file.slice(0, -3));
		try {
			const result = await inspect(owner, id, holds.has(id));
			rows.push(result.row);
			if (result.candidate) candidates.push(result.candidate);
		} catch {
			rows.push({
				id,
				kind: 'unverified',
				read: false,
				confirmed: false,
				held: holds.has(id),
				disposition: 'KEEP',
				reason: 'identity-or-header-unverified',
			});
		}
	}
	const next = remaining.length > page.length ? page.at(-1)?.slice(0, -3) : undefined;
	return {
		owner,
		readOnly: true,
		rows,
		candidateCount: candidates.length,
		next: next ?? null,
		plan:
			candidates.length > 0
				? Buffer.from(JSON.stringify({ version: 1, owner, candidates })).toString(
						'base64url',
					)
				: null,
		instruction:
			'Only fully read receipt-kind bookkeeping without a hold is eligible. Requests, replies, confirmations, notices and unknown kinds stay pending. A later live apply needs separate operator approval.',
	};
}

/** Apply only a fresh preview against the same own mailbox; partial success is retained. */
export async function applyBulkArchive(owner: string, token: string) {
	ownMailbox(owner);
	const plan = decodePlan(token, owner);
	const root = mailboxPath(owner);
	const archived: string[] = [];
	for (const candidate of plan.candidates) {
		try {
			await safeDirectories(root);
			await locked(statePath(owner, candidate.id, 'handling.lock'), async () => {
				const holds = new Set((await ownHolds(owner)).map((hold) => hold.messageId));
				const current = await inspect(owner, candidate.id, holds.has(candidate.id));
				if (
					current.candidate?.sha256 !== candidate.sha256 ||
					current.candidate.readSha256 !== candidate.readSha256
				)
					throw new Error(`Bulk archive inputs changed at ${candidate.id}; re-preview.`);
				const retained = join(root, 'archive', `${candidate.id}.md`);
				if (
					await lstat(retained).catch((error: unknown) => {
						if (missing(error)) return null;
						throw error;
					})
				)
					throw new Error(`Bulk archive target appeared at ${candidate.id}; re-preview.`);
				await archiveMessage(root, candidate.id);
				archived.push(candidate.id);
			});
		} catch (error: unknown) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Bulk archive stopped at ${candidate.id}; already archived ${archived.length}: ${archived.join(', ') || 'none'}. ${detail}`,
				{ cause: error },
			);
		}
	}
	return {
		owner,
		archived,
		instruction:
			'Only own read receipts moved to archive. No bodies or delivery/read markers were deleted. If interrupted, re-preview the remaining inbox; do not replay an old plan.',
	};
}
