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
import { telegramPollInterval } from './receiver-cadence.ts';
import { nextReceiverDeadline } from './receiver-deadlines.ts';
import { createReceiverPump } from './receiver-pump.ts';
import { receiverWatchSources } from './receiver-watch-sources.ts';
import { pollWakeTelegram } from './telegram-live.ts';
import { createWakeCoordinator } from './wake-coordinator.ts';
import { retainWakeError, wakeErrors } from './wake-errors.ts';

const localWakes = new Map<string, () => void>();

/** A cleared in-memory terminal draft has no file event, so its owned receiver gets a direct wake. */
export function wakeMailWatcher(name: string, nonce: string): void {
	localWakes.get(`${name}:${nonce}`)?.();
}

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
	let pollBusy: Promise<void> | undefined;
	const inbox = join(mailboxPath(name), 'inbox');
	await mkdir(inbox, { recursive: true, mode: 0o700 });
	const telegramPollState = {
		failed: (await wakeErrors(name)).some(
			(error) =>
				!error.recoveredAt &&
				error.observedNonce === nonce &&
				error.stage === 'telegram inventory',
		),
	};
	const tick = createWakeCoordinator(
		name,
		nonce,
		send,
		() => !stopped,
		release.owns,
		options,
		telegramPollState,
	);
	const reportCycle = async (error: unknown): Promise<void> => {
		const retained = await retainWakeError(name, 'receiver cycle', error);
		await saveDelivery(name, {
			...(await deliveryStatus(name, nonce)),
			state: 'queued-only',
			reason: 'A receiver cycle failed; inspect own wake errors and delivery outcome.',
		});
		if (retained.changed)
			console.error(`${name}: receiver cycle failed; inspect own mail status.`);
	};
	const sources = await receiverWatchSources(name);
	const pump = createReceiverPump(
		tick,
		async (cycleStartedAt) =>
			stopped ? undefined : nextReceiverDeadline(name, nonce, Date.now(), cycleStartedAt),
		reportCycle,
	);
	const { schedule } = pump;
	const key = `${name}:${nonce}`;
	const watchers: ReturnType<typeof watch>[] = [];
	for (const source of sources) {
		try {
			await mkdir(source.directory, { recursive: true, mode: 0o700 });
			const watcher = watch(source.directory, (_event, filename) => {
				if (source.accept(filename?.toString() ?? null)) schedule();
			});
			watcher.on('error', () => watcher.close());
			watchers.push(watcher);
		} catch {
			/* An inaccessible or unsupported watch remains covered by the bounded rescan. */
		}
	}
	// Remote polling has its own cadence, so an idle Telegram check does not rescan every local source.
	const pollTimer = setInterval(() => {
		if (stopped || pollBusy) return;
		pollBusy = release
			.owns()
			.then(async (owns) =>
				owns
					? pollWakeTelegram(name, () => {
							telegramPollState.failed = false;
						})
					: 0,
			)
			.then((count) => {
				if (count) schedule();
			})
			.catch(async (error: unknown) => {
				telegramPollState.failed = true;
				try {
					await retainWakeError(name, 'telegram inventory', error);
				} catch {
					console.error(`${name}: Telegram poll failure could not be retained.`);
				}
			})
			.finally(() => {
				pollBusy = undefined;
			});
	}, telegramPollInterval());
	localWakes.set(key, schedule);
	schedule();
	return async () => {
		stopped = true;
		clearInterval(pollTimer);
		for (const watcher of watchers) watcher.close();
		await pump.stop();
		if (localWakes.get(key) === schedule) localWakes.delete(key);
		await pollBusy;
		await release();
		await saveDelivery(name, {
			...(await deliveryStatus(name, nonce)),
			state: 'queued-only',
			reason: 'Session receiver closed; mail remains queued.',
		});
	};
}
