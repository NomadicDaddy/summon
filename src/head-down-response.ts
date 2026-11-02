import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { HeadDownState } from './head-down-model.ts';
import type { WakeSend } from './wake-part.ts';

import { readActivity } from './agent-activity.ts';
import { headDownView, readHeadDown } from './head-down-model.ts';
import { isHibernated } from './hibernation.ts';
import { atomicWrite, locked, missing, optionalText } from './mail-files.ts';
import { runtimePath } from './mail-session.ts';
import { assertNotificationOpen, NotificationNotSentError } from './notification-delivery.ts';
import { operatorViewing } from './operator-view.ts';
import { restSuppressed } from './rest.ts';

async function decision(name: string, nonce: string): Promise<HeadDownState | undefined> {
	const state = await readHeadDown(name);
	if (!state || state.nonce !== nonce || !state.approvedBy) return undefined;
	if ((await readActivity(name))?.nonce !== nonce) return undefined;
	if (state.phase === 'active' && state.decision === 'approved') {
		if ((await headDownView(name))?.id === state.id) return state;
	} else if (state.phase === 'ended' && state.decision === 'declined') return state;
	return undefined;
}

async function restore(path: string, previous: string | undefined): Promise<void> {
	if (previous !== undefined) await atomicWrite(path, previous);
	else
		await unlink(path).catch((error: unknown) => {
			if (!missing(error)) throw error;
		});
}

/**
 * A decision must reach the requester before active head-down queues ordinary notices.
 * Only that gate is bypassed: human pauses, hibernation, rest, native idle/draft and halt remain.
 * The marker records attempted input, never a model read or acceptance of unrelated work.
 */
export async function deliverHeadDownResponse(
	name: string,
	nonce: string,
	send: WakeSend,
	canSend: () => Promise<boolean>,
): Promise<boolean> {
	if (!/^[a-z0-9-]+$/i.test(nonce)) throw new Error('Invalid launch nonce.');
	const path = join(runtimePath(name), `${nonce}.head-down-response`);
	return locked(`${path}.lock`, async () => {
		const state = await decision(name, nonce);
		if (!state) return false;
		const key = `${state.id}:${state.phase}`;
		const previous = await optionalText(path);
		if (
			previous !== undefined &&
			!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:(?:active|ended)$/i.test(previous)
		)
			throw new Error('Invalid head-down response marker; inspect own delivery state.');
		if (previous === key) return false;
		const allowed = async (): Promise<boolean> => {
			const current = await decision(name, nonce);
			return (
				current?.id === state.id &&
				current.phase === state.phase &&
				current.decision === state.decision &&
				!(await isHibernated(name)) &&
				!(await operatorViewing(name)) &&
				!(await restSuppressed(name)) &&
				(await canSend())
			);
		};
		// Keep an owed decision pending without touching ordinary cursors or mailbox receipts.
		if (!(await allowed())) return true;
		await assertNotificationOpen();
		let attempted = false;
		try {
			await atomicWrite(path, key);
			attempted = true;
			await send(
				`Summon head-down decision: request ${state.id} was ${state.phase === 'active' ? 'approved' : 'declined'}. ` +
					'Run summon --head-down status and act only within that recorded decision. ' +
					'This releases no held mail and grants no unrelated work or lifecycle action.',
				allowed,
			);
		} catch (error: unknown) {
			// A definitely unsent input can retry. An uncertain write must never repeat itself.
			if (!attempted || error instanceof NotificationNotSentError)
				await restore(path, previous);
			throw error;
		}
		return true;
	});
}
