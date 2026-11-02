import { join } from 'node:path';

import type { CheckpointPackage } from './checkpoint-package-model.ts';
import type { WakePart } from './wake-part.ts';

import { checkpointHash, parseCheckpointState } from './checkpoint-package-model.ts';
import { checkpointStatePath } from './checkpoint-package-store.ts';
import { ownHolds } from './mail-attention.ts';
import { atomicWrite, missing, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { header, statePath } from './mail-read.ts';
import { runtimePath } from './mail-session.ts';
import { pendingMessages } from './mailbox.ts';
import { wakeTargetRead } from './wake-read-proof.ts';

export function deliveryNotice(
	name: string,
	nonce: string,
	introduced: boolean,
	mailCount: number,
	decisionCount: number,
	confirmationCount = 0,
): string {
	if (!introduced)
		return [
			`summon mailbox readiness: run summon --mail ready ${nonce}.`,
			'Before historical catch-up, set your first busy/idle status for this launch.',
			'Then use summon --mail receive for your own pending mail and summon --mail holds for approval decisions.',
			'This is a transport check, not approval to perform requests.',
		].join(' ');
	if (decisionCount > 0 && mailCount === 0)
		return `summon: ${decisionCount} approval decision(s) for ${name}. At the next safe checkpoint run summon --mail holds. Act only inside an approved proposal.`;
	if (decisionCount > 0)
		return `summon: ${mailCount} new mail item(s) and ${decisionCount} approval decision(s) for ${name}. At the next safe checkpoint run summon --mail receive and summon --mail holds. Assess, confirm, act or hold; only user approval releases holds.`;
	// The focused view leaves confirmations out by design, so a notice that only points there would
	// look empty; confirmations are routed to the read that shows them.
	if (confirmationCount > 0 && confirmationCount === mailCount)
		return `summon: ${mailCount} new confirmation(s) for ${name}. summon --current-requests leaves confirmations out; read them with summon --mail receive at the next safe boundary. Reading one confirms nothing; reply or act only as its content requires.`;
	const base = `summon: ${mailCount} new mailbox event(s) for ${name}. At the next safe boundary read summon --current-requests --format text before historical catch-up, then use summon-receive. Assess, confirm, act or hold; only user approval releases holds.`;
	if (confirmationCount > 0)
		return `${base} ${confirmationCount} of them are confirmations, which summon --current-requests leaves out; read those with summon --mail receive.`;
	return base;
}

const attemptsPath = (name: string, nonce: string): string =>
	join(runtimePath(name), `${nonce}.attempts`);
async function seen(name: string, nonce: string): Promise<Set<string>> {
	ownMailbox(name);
	return new Set(
		((await optionalText(attemptsPath(name, nonce))) ?? '').split('\n').filter(Boolean),
	);
}
async function markKeys(
	name: string,
	nonce: string,
	keys: string[],
	deferred: boolean,
): Promise<void> {
	const values = await seen(name, nonce);
	for (const key of keys) {
		if (deferred) values.delete(key);
		else values.add(key);
	}
	await atomicWrite(attemptsPath(name, nonce), [...values].join('\n'));
}

export async function prepareReadiness(
	name: string,
	nonce: string,
	reminder = false,
): Promise<WakePart | undefined> {
	ownMailbox(name);
	const acknowledged = async (): Promise<boolean> =>
		(await optionalText(join(runtimePath(name), `${nonce}.ready`))) === nonce;
	if ((await acknowledged()) || (!reminder && (await seen(name, nonce)).has('ready')))
		return undefined;
	return {
		target: { source: 'readiness', key: nonce, through: 0, ids: [] },
		text: deliveryNotice(name, nonce, false, 0, 0),
		needed: async () => !(await acknowledged()),
		acknowledged,
		mark: async (state) => {
			await markKeys(name, nonce, ['ready'], state === 'deferred');
		},
	};
}

/** The ids of this launch's last mail notice a queueing provider accepted (see prepareMailNotice). */
const queuedMailPath = (name: string, nonce: string): string =>
	join(runtimePath(name), `${nonce}.mail-queued`);

/** Still waiting for its reader: pending, not read, and not an obsolete notice. */
async function awaitsRead(name: string, id: string, pending: Set<string>): Promise<boolean> {
	if (!pending.has(`${id}.md`) || (await optionalText(statePath(name, id, 'read')))) return false;
	const current = await header(name, id).catch((error: unknown) => {
		if (missing(error)) return undefined;
		throw error;
	});
	return !!current && current.noticeStatus !== 'obsolete';
}

/**
 * `coalesceQueued` is for a receiver whose provider queues submitted input and cannot withdraw it
 * (Codex, #24276). The submitted notice already says to read current requests, which lists later
 * mail too, so no further mail notice is submitted while any id it named still awaits its reader.
 */
export async function prepareMailNotice(
	name: string,
	nonce: string,
	packet?: CheckpointPackage,
	coalesceQueued = false,
): Promise<WakePart | undefined> {
	const previous = await seen(name, nonce);
	const covered = new Set(
		packet?.items.filter((item) => item.source === 'mail').map((item) => item.id),
	);
	if (coalesceQueued) {
		const queued = ((await optionalText(queuedMailPath(name, nonce))) ?? '')
			.split('\n')
			.filter(Boolean);
		const pending = new Set(await pendingMessages(name));
		for (const id of queued)
			if (!covered.has(id) && (await awaitsRead(name, id, pending))) return undefined;
	}
	const ids: string[] = [];
	let confirmations = 0;
	for (const file of await pendingMessages(name)) {
		const id = file.slice(0, -3);
		if (!/^[0-9a-f-]{36}$/.test(id) || previous.has(id) || covered.has(id)) continue;
		const mail = await header(name, id).catch((error: unknown) => {
			if (missing(error)) return undefined;
			throw error;
		});
		if (
			!mail ||
			mail.kind === 'receipt' ||
			mail.noticeStatus === 'obsolete' ||
			(await optionalText(statePath(name, id, 'read')))
		)
			continue;
		// Retained readiness bookkeeping never becomes a new work notice.
		if (mail.kind === 'rest-ready') continue;
		if (mail.kind === 'confirmation') confirmations++;
		ids.push(id);
	}
	if (!ids.length) return undefined;
	const acknowledged = async (): Promise<boolean> =>
		(
			await Promise.all(
				ids.map(async (id) => !!(await optionalText(statePath(name, id, 'read')))),
			)
		).every(Boolean);
	return {
		target: { source: 'mail', key: 'inbox', through: 0, ids },
		text: deliveryNotice(name, nonce, true, ids.length, 0, confirmations),
		needed: async () => {
			const pending = new Set(await pendingMessages(name));
			return (
				await Promise.all(
					ids.map(async (id) => {
						if (
							!pending.has(`${id}.md`) ||
							(await optionalText(statePath(name, id, 'read')))
						)
							return false;
						const current = await header(name, id).catch((error: unknown) => {
							if (missing(error)) return undefined;
							throw error;
						});
						return !!current && current.noticeStatus !== 'obsolete';
					}),
				)
			).some(Boolean);
		},
		acknowledged,
		mark: async (state) => {
			await markKeys(name, nonce, ids, state === 'deferred');
			if (coalesceQueued && state === 'queued')
				await atomicWrite(queuedMailPath(name, nonce), ids.join('\n'));
		},
	};
}

export async function prepareHoldNotice(
	name: string,
	nonce: string,
	packet?: CheckpointPackage,
): Promise<WakePart | undefined> {
	const previous = await seen(name, nonce);
	const state = parseCheckpointState(await optionalText(checkpointStatePath(name)));
	const holds = (await ownHolds(name))
		.filter(
			(hold) =>
				hold.decision !== 'pending' &&
				!previous.has(`hold:${hold.id}:${hold.decision}`) &&
				packet?.sources.holds[hold.id] !== checkpointHash(hold) &&
				state.seenHolds[hold.id] !== checkpointHash(hold),
		)
		.sort((a, b) => a.id.localeCompare(b.id));
	if (!holds.length) return undefined;
	const keys = holds.map((hold) => `hold:${hold.id}:${hold.decision}`);
	const target = {
		source: 'holds' as const,
		key: 'decisions',
		through: 0,
		ids: holds.map((hold) => `hold:${hold.id}:${checkpointHash(hold)}`),
	};
	return {
		target,
		text: deliveryNotice(name, nonce, true, 0, keys.length),
		needed: async () => {
			const current = new Set(
				(await ownHolds(name)).map((hold) => `hold:${hold.id}:${hold.decision}`),
			);
			return keys.some((key) => current.has(key));
		},
		// Decision storage is not read coverage; only the frozen package final receipt covers it.
		acknowledged: async () => wakeTargetRead(name, nonce, target),
		mark: async (state) => {
			await markKeys(name, nonce, keys, state === 'deferred');
		},
	};
}
