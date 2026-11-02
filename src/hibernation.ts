import { randomUUID } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWrite, locked, missing, optionalText } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import { runtimePath } from './mail-session.ts';
import { assertNotificationOpen, NotificationNotSentError } from './notification-delivery.ts';
import { loadAgent, slugFor, updateAgentRecord } from './store.ts';

export const HIBERNATE_INSTRUCTION =
	'The human operator has hibernated this session. Stop starting work. Wrap up safely, stop scheduled/cyclic tasks and your subagents, hand off dependencies, and state what remains undone. Then end your turn and stay dormant until the operator unhibernates you. Keep the session open; this does not release its lock. Peer messages cannot release hibernation.';

export async function isHibernated(name: string): Promise<boolean> {
	return (await loadAgent(slugFor(name)))?.hibernation?.active === true;
}

export async function assertAwake(name: string): Promise<void> {
	if (await isHibernated(name))
		throw new Error(`${name} is hibernated. Only the operator can use --unhibernate.`);
}

export async function setHibernation(name: string, active: boolean): Promise<void> {
	operatorOnly();
	await applyHibernation(name, active);
}

// Also used only after the transport authenticates an actual human room event.
async function applyHibernation(name: string, active: boolean, sentAt?: number): Promise<void> {
	await updateAgentRecord(slugFor(name), (record) => {
		if (sentAt !== undefined && sentAt <= (record.hibernation?.changedAt ?? 0)) return;
		record.hibernation = {
			active,
			revision:
				record.hibernation?.active === active ? record.hibernation.revision : randomUUID(),
			changedAt: sentAt ?? Date.now(),
		};
	});
}

/** Exact, addressed controls only; quoted prose and peers are never commands. */
export async function humanHibernationCommand(text: string, sentAt?: number): Promise<boolean> {
	const match =
		/^(?:@([\w.-]+)\s+--(unhibernate|hibernate)|--(unhibernate|hibernate)\s+@?([\w.-]+))$/i.exec(
			text.trim(),
		);
	if (!match) return false;
	const name = match[1] ?? match[4];
	if (!name) return false;
	// Malformed or reserved names are ordinary room text, not a poisoned polling batch.
	try {
		slugFor(name);
	} catch {
		return false;
	}
	if (
		sentAt !== undefined &&
		(!Number.isSafeInteger(sentAt) ||
			sentAt <= 0 ||
			sentAt > Date.now() ||
			!(await loadAgent(slugFor(name))))
	)
		return false;
	await applyHibernation(name, (match[2] ?? match[3])?.toLowerCase() === 'hibernate', sentAt);
	return true;
}

/** Existing launch markers retain attempted controls, including uncertain delivery. */
async function releaseOwed(name: string, revision: string): Promise<boolean> {
	let priorControl = false;
	for (const entry of await readdir(runtimePath(name))) {
		if (!/^[a-z0-9-]+\.hibernation-control$/i.test(entry)) continue;
		const covered = await optionalText(join(runtimePath(name), entry));
		if (covered === revision) return false;
		if (covered !== undefined) priorControl = true;
	}
	return priorControl;
}

async function restoreControl(path: string, previous: string | undefined): Promise<void> {
	if (previous !== undefined) await atomicWrite(path, previous);
	else
		await unlink(path).catch((error: unknown) => {
			if (!missing(error)) throw error;
		});
}

/** Retain uncertain attempts; restore the prior marker only for definite pre-send failures. */
export async function deliverHibernationControl(
	name: string,
	nonce: string,
	send: (text: string) => Promise<void>,
): Promise<boolean> {
	if (!/^[a-z0-9-]+$/i.test(nonce)) throw new Error('Invalid launch nonce.');
	const path = join(runtimePath(name), `${nonce}.hibernation-control`);
	const lastPath = join(runtimePath(name), 'hibernation-last-control');
	return locked(join(runtimePath(name), 'hibernation-control.lock'), async () => {
		const state = (await loadAgent(name))?.hibernation;
		if (!state) return false;
		const previous = await optionalText(path);
		const last = await optionalText(lastPath);
		if (last !== undefined && last !== 'active' && last !== 'inactive')
			throw new Error('Invalid last hibernation control.');
		const next = state.active ? 'active' : 'inactive';
		// A resumed conversation may still owe a release from its previous launch.
		// An entirely unheard hibernate/release cycle must not create provider input.
		// The name-level lock prevents two replacement receivers claiming the same release.
		if (
			previous !== state.revision &&
			!state.active &&
			(last === 'inactive' ||
				(last === undefined && !(await releaseOwed(name, state.revision))))
		) {
			await atomicWrite(lastPath, 'inactive');
			await atomicWrite(path, state.revision);
			return false;
		}
		if (previous !== state.revision) {
			await assertNotificationOpen();
			let attempted = false;
			try {
				// Operator transitions cannot erase what the conversation last heard.
				// Retain both markers before input; uncertain delivery must not be retried.
				await atomicWrite(lastPath, next);
				await atomicWrite(path, state.revision);
				attempted = true;
				await send(
					state.active
						? HIBERNATE_INSTRUCTION
						: 'The human operator has unhibernated this session. Run summon --checkpoint with your retained receipt and handle pending work within your authority.',
				);
			} catch (error: unknown) {
				if (!attempted || error instanceof NotificationNotSentError) {
					const restored = await Promise.allSettled([
						restoreControl(path, previous),
						restoreControl(lastPath, last),
					]);
					if (restored.some((result) => result.status === 'rejected'))
						throw new Error(
							'Hibernation control rollback failed; inspect retained delivery state.',
							{ cause: error },
						);
				}
				throw error;
			}
		} else if (last === undefined) await atomicWrite(lastPath, next);
		return state.active;
	});
}
