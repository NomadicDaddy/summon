import { watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ReceiverLease } from './mail-session.ts';
import type { WakeSend } from './wake-part.ts';

import { optionalText } from './mail-files.ts';
import {
	acquireReceiver,
	awaitingReadinessReason,
	deliveryStatus,
	runtimePath,
	saveDelivery,
} from './mail-session.ts';
import { mailboxPath } from './mailbox.ts';
import { assertNotificationOpen } from './notification-delivery.ts';
import { createWakeCoordinator } from './wake-coordinator.ts';
import { retainWakeError } from './wake-errors.ts';

export interface WakeReceiverOptions {
	noticeAllowed?: () => Promise<boolean>;
	/** Expensive native observations run only after eligible ordinary work is collected. */
	noticeCheckWhenPending?: boolean;
	/** A hold reason, clear (null), or no report. Pending describes this cycle's inventory. */
	noticeHold?: (pending: boolean) => Promise<string | null | undefined>;
	controlSend?: (text: string) => Promise<void>;
	readinessReminder?: boolean;
	/**
	 * The provider queues submitted input and Summon cannot withdraw it (Codex). Room and mail then
	 * submit no further notice while the last submitted one is unread; see prepareMailNotice.
	 */
	coalesceQueuedNotices?: boolean;
}

export async function startMailWatcher(
	name: string,
	nonce: string,
	send: WakeSend,
	options: WakeReceiverOptions = {},
): Promise<() => Promise<void>> {
	let stopped = false;
	let cleanup: (() => Promise<void>) | undefined;
	let pending: Promise<void> | undefined;
	const deliver: WakeSend = async (text, revalidate) => {
		await assertNotificationOpen();
		await send(text, revalidate);
	};
	const attempt = async (): Promise<void> => {
		if (!stopped && !cleanup)
			cleanup = await tryStartMailWatcher(name, nonce, deliver, options);
	};
	await attempt();
	const timer = setInterval(() => {
		if (stopped || cleanup || pending) return;
		pending = attempt()
			.catch((error: unknown) => console.error('Receiver handoff:', error))
			.finally(() => {
				pending = undefined;
			});
	}, 1000);
	return async () => {
		stopped = true;
		clearInterval(timer);
		await pending;
		await cleanup?.();
	};
}

async function tryStartMailWatcher(
	name: string,
	nonce: string,
	send: WakeSend,
	options: WakeReceiverOptions,
): Promise<(() => Promise<void>) | undefined> {
	const release = await acquireReceiver(name, nonce);
	if (!release) {
		await saveDelivery(name, {
			...(await deliveryStatus(name, nonce)),
			state: 'queued-only',
			reason: "Another session owns this name's receiver.",
		});
		return undefined;
	}
	try {
		return await initializeMailWatcher(name, nonce, send, release, options);
	} catch (error: unknown) {
		await release();
		throw error;
	}
}

async function initializeMailWatcher(
	name: string,
	nonce: string,
	send: WakeSend,
	release: ReceiverLease,
	options: WakeReceiverOptions,
): Promise<() => Promise<void>> {
	await optionalText(join(runtimePath(name), `${nonce}.attempts`));
	const initial = await deliveryStatus(name, nonce);
	await saveDelivery(name, {
		...initial,
		pid: process.pid,
		state: 'unconfirmed',
		reason: awaitingReadinessReason,
	});
	let stopped = false;
	let busy: Promise<void> | undefined;
	const inbox = join(mailboxPath(name), 'inbox');
	await mkdir(inbox, { recursive: true, mode: 0o700 });
	const tick = createWakeCoordinator(name, nonce, send, () => !stopped, release.owns, options);
	const schedule = (): void => {
		if (!busy)
			busy = tick()
				.catch(async (error: unknown) => {
					try {
						const retained = await retainWakeError(name, 'receiver cycle', error);
						await saveDelivery(name, {
							...(await deliveryStatus(name, nonce)),
							state: 'queued-only',
							reason: 'A receiver cycle failed; inspect own wake errors and delivery outcome.',
						});
						if (retained.changed)
							console.error(
								`${name}: receiver cycle failed; inspect own mail status.`,
							);
					} catch {
						console.error(
							`${name}: receiver failure could not be retained; inspect own delivery storage before retrying.`,
						);
					}
				})
				.finally(() => {
					busy = undefined;
				});
	};
	let watcher: ReturnType<typeof watch> | undefined;
	try {
		watcher = watch(inbox, schedule);
		watcher.on('error', () => {
			watcher?.close();
		});
	} catch {
		/* The rescan below remains authoritative on filesystems without watch support. */
	}
	const timer = setInterval(schedule, 2000);
	schedule();
	return async () => {
		stopped = true;
		clearInterval(timer);
		watcher?.close();
		await busy;
		await release();
		await saveDelivery(name, {
			...(await deliveryStatus(name, nonce)),
			state: 'queued-only',
			reason: 'Session receiver closed; mail remains queued.',
		});
	};
}
