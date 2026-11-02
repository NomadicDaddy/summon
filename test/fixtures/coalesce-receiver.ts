import type { ReceiverLease } from '../../src/mail-session.ts';
import type { WakeReceiverOptions } from '../../src/mail-watcher.ts';

import { initializeActivity } from '../../src/agent-activity.ts';
import { appendLocalEvent } from '../../src/local-room.ts';
import { atomicWrite } from '../../src/mail-files.ts';
import { acquireReceiver, markReady, saveDelivery } from '../../src/mail-session.ts';
import { localCursorPath } from '../../src/room-cursor.ts';
import { createWakeCoordinator } from '../../src/wake-coordinator.ts';

// #24276 fixtures: the real coordinator, delivery and mark path for one member, with a capturing
// sender in place of `codex queue`. No provider, no team store, no idle claim of any kind.

let lease: ReceiverLease | undefined;

/** Releases the previous fixture lease, so a test can open a second launch. */
export async function releaseFixtureReceiver(): Promise<void> {
	await lease?.();
	lease = undefined;
}

/**
 * One receiver for `alpha` under `nonce`. `sent` holds each submitted notice text. `fail` may throw
 * from the sender: a NotificationNotSentError is definitely unsent, any other error is uncertain.
 */
export async function coalesceReceiver(
	nonce: string,
	options: WakeReceiverOptions,
	{ ready = true, fail }: { ready?: boolean; fail?: () => Error | undefined } = {},
) {
	await releaseFixtureReceiver();
	await initializeActivity('alpha', nonce);
	lease = await acquireReceiver('alpha', nonce);
	if (!lease) throw new Error('Fixture receiver lease missing.');
	const current = lease;
	await saveDelivery('alpha', {
		nonce,
		pid: process.pid,
		state: 'unconfirmed',
		reason: '',
		thread: 'fixture-thread',
	});
	if (ready) await markReady('alpha', nonce);
	const sent: string[] = [];
	const cycle = createWakeCoordinator(
		'alpha',
		nonce,
		(text) => {
			const error = fail?.();
			if (error) return Promise.reject(error);
			sent.push(text);
			return Promise.resolve();
		},
		() => true,
		current.owns,
		options,
	);
	return { cycle, sent };
}

export const operatorPost = (text: string) =>
	appendLocalEvent({
		sender: { kind: 'user', id: 'operator' },
		text,
		replyTo: null,
		source: 'local',
	});

/** What alpha's own checkpoint receipt would leave behind; used only where a read is the subject. */
export const readRoomThrough = (id: number) => atomicWrite(localCursorPath('alpha'), String(id));
