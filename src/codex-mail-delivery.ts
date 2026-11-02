import { join } from 'node:path';

import { codexCompactionReader } from './codex-compaction-history.ts';
import { codexNoticeGate } from './codex-notice-gate.ts';
import {
	classifyQueueFailure,
	CodexQueueError,
	drainBounded,
	recordQueueFailure,
} from './codex-queue-failures.ts';
import { requireExecutable } from './executable.ts';
import { optionalText } from './mail-files.ts';
import { deliveryStatus, runtimePath, saveDelivery } from './mail-session.ts';
import { startMailWatcher } from './mail-watcher.ts';
import { assertNotificationOpen, NotificationNotSentError } from './notification-delivery.ts';

export async function queueCodex(
	thread: string,
	text: string,
	timeoutMs = 15000,
	revalidate?: () => Promise<boolean>,
): Promise<void> {
	if (!/^[a-zA-Z0-9_-]{8,128}$/.test(thread))
		throw new NotificationNotSentError('An exact Codex thread ID is required.');
	let executable: string;
	try {
		executable = requireExecutable('codex');
	} catch (error: unknown) {
		throw new NotificationNotSentError('Codex executable is unavailable.', { cause: error });
	}
	await assertNotificationOpen();
	if (revalidate) {
		try {
			if (!(await revalidate()))
				throw new NotificationNotSentError('Codex notice changed before queue submission.');
		} catch (error: unknown) {
			throw new NotificationNotSentError('Codex notice could not be revalidated.', {
				cause: error,
			});
		}
	}
	await assertNotificationOpen();
	let child: Bun.Subprocess<'ignore', 'ignore', 'pipe'>;
	try {
		child = Bun.spawn({
			cmd: [executable, 'queue', '--thread', thread, '--message', text],
			stdin: 'ignore',
			stdout: 'ignore',
			stderr: 'pipe',
			windowsHide: true,
		});
	} catch {
		throw new CodexQueueError('spawn-failed', null, 'unclassified');
	}
	const timer = { expired: false };
	const timeout = setTimeout(() => {
		timer.expired = true;
		child.kill();
	}, timeoutMs);
	const reading = new AbortController();
	let grace: ReturnType<typeof setTimeout> | undefined;
	try {
		// Drained so the child never blocks; the text is classified here and dropped.
		const draining = drainBounded(child.stderr, reading.signal);
		// Handled now, so a drain that fails while the exit is awaited is not an unhandled
		// rejection that ends the session; awaiting it below still raises the error.
		draining.catch(() => undefined);
		const code = await child.exited;
		// The child's exit or the kill decides the outcome, read at the moment it ends.
		const timedOut = timer.expired;
		// A detached descendant can hold the inherited pipe long after the child is gone
		// (measured: a 300 ms exit 0 waited 6 s); keep what arrived shortly after, then stop.
		grace = setTimeout(() => reading.abort(), 500);
		const output = await draining;
		if (timedOut) throw new CodexQueueError('timeout', null, 'unclassified');
		if (code !== 0) throw new CodexQueueError('exit', code, classifyQueueFailure(output));
	} finally {
		clearTimeout(timeout);
		clearTimeout(grace);
	}
}

/** Diagnostics never change a send's result: a failed record leaves the original error. */
export async function queueRecorded(
	name: string,
	nonce: string,
	thread: string,
	text: string,
	revalidate?: () => Promise<boolean>,
): Promise<void> {
	try {
		await queueCodex(thread, text, undefined, revalidate);
	} catch (error: unknown) {
		if (error instanceof CodexQueueError)
			await recordQueueFailure(name, nonce, error).catch(() =>
				console.error(`${name}: Codex queue diagnostics could not be recorded.`),
			);
		throw error;
	}
}

export function waitForCodexBinding(
	name: string,
	nonce: string,
	resumedThread?: string,
): () => Promise<void> {
	let stopped = false;
	let cleanup: (() => Promise<void>) | undefined;
	let pending: Promise<void> | undefined;
	const observeCompactions = codexCompactionReader(name, nonce);
	const gate = codexNoticeGate(name, nonce);
	const poll = async (): Promise<void> => {
		if (stopped) return;
		if (cleanup) {
			await observeCompactions();
			return;
		}
		const thread =
			(await optionalText(join(runtimePath(name), `${nonce}.binding`))) ?? resumedThread;
		if (!thread) return;
		await saveDelivery(name, { ...(await deliveryStatus(name, nonce)), thread });
		cleanup = await startMailWatcher(
			name,
			nonce,
			async (text, revalidate) => {
				const current =
					(await optionalText(join(runtimePath(name), `${nonce}.binding`))) ??
					resumedThread;
				if (!current)
					throw new NotificationNotSentError('Codex thread binding is unavailable.');
				const status = await deliveryStatus(name, nonce);
				if (status.thread !== current)
					await saveDelivery(name, { ...status, thread: current });
				await queueRecorded(
					name,
					nonce,
					current,
					text,
					// Explicit operator controls have no ordinary-notice validator and retain
					// their existing path. Ordinary input must still name this exact binding.
					revalidate
						? async () =>
								(await revalidate()) &&
								((await optionalText(
									join(runtimePath(name), `${nonce}.binding`),
								)) ?? resumedThread) === current
						: undefined,
				);
			},
			// `codex queue` holds input until the thread is idle and has no withdraw (#24276).
			{ coalesceQueuedNotices: true, ...gate },
		);
		await observeCompactions();
	};
	const timer = setInterval(() => {
		if (!pending)
			pending = poll()
				.catch((error: unknown) => console.error('Codex mail:', error))
				.finally(() => {
					pending = undefined;
				});
	}, 500);
	return async () => {
		stopped = true;
		clearInterval(timer);
		await pending;
		// Bound shutdown work; a later launch replays remaining metadata with native-ID deduplication.
		let complete = false;
		for (let count = 0; count < 8 && !complete; count++) complete = await observeCompactions();
		if (!complete)
			console.error(
				'Codex compaction backfill remains incomplete; it can resume on the next launch.',
			);
		await cleanup?.();
	};
}
