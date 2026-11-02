import { join } from 'node:path';

import type { CheckpointPackage } from './checkpoint-package-model.ts';
import type { DeliveryState } from './mail-session.ts';
import type { WakeReceiverOptions } from './mail-watcher.ts';
import type { WakeStage } from './wake-errors.ts';
import type { WakePart, WakeSend } from './wake-part.ts';

import { automaticNoticeSuppressed } from './automatic-notice.ts';
import { communicationState } from './communication-state.ts';
import { deliverHeadDownResponse } from './head-down-response.ts';
import { deliverHibernationControl } from './hibernation.ts';
import { prepareLocalRoomNotice } from './local-room-live.ts';
import { optionalText } from './mail-files.ts';
import { prepareHoldNotice, prepareMailNotice, prepareReadiness } from './mail-notice.ts';
import {
	awaitingReadinessReason,
	deliveryStatus,
	noticesHeldPrefix,
	runtimePath,
	saveDelivery,
} from './mail-session.ts';
import { NotificationNotSentError } from './notification-delivery.ts';
import { trackResponseSafely } from './response-watchdog-safety.ts';
import { evaluateResponseWatchdog } from './response-watchdog.ts';
import { roomWakePolicy } from './room-wake-policy.ts';
import { pollWakeTelegram, prepareTelegramNotice } from './telegram-live.ts';
import { wakeDeliveryRetained } from './wake-delivery-store.ts';
import { deliverWakeParts } from './wake-delivery.ts';
import { recoverWakeError, retainWakeError, wakeErrors } from './wake-errors.ts';
import { activeWakeReadBoundary, wakePartCovered } from './wake-read-boundary.ts';

const confirmedReason = "Model confirmed receipt of this launch's notification.";
const unsentReason = 'A notification remains unsent; inspect own wake errors and delivery outcome.';
const uncertainReason =
	'Provider input may have begun; inspect the delivery outcome before retrying.';
const inventoryReason =
	'Notification inventory could not be read; inspect own wake errors and delivery outcome.';
const inventoryStages = new Set<WakeStage>([
	'mail inventory',
	'room inventory',
	'telegram inventory',
	'approval inventory',
	'checkpoint inventory',
]);

/** What the retained delivery outcomes still say, apart from this cycle's own result. */
function retainedOutcome(delivery: Awaited<ReturnType<typeof wakeDeliveryRetained>>): {
	failed: boolean;
	uncertain: boolean;
} {
	return {
		failed: delivery.unresolved.some((value) => value.state === 'not-sent'),
		uncertain:
			delivery.unresolved.some(
				(value) => value.state === 'uncertain' || value.state === 'attempted',
			) || delivery.more,
	};
}

/** One serialized cycle per receiver lease; independent inventory failures preserve healthy wakes. */
export function createWakeCoordinator(
	name: string,
	nonce: string,
	send: WakeSend,
	active: () => boolean,
	owns: () => Promise<boolean>,
	options: WakeReceiverOptions,
): () => Promise<void> {
	const startedAt = Date.now();
	const report = async (stage: WakeStage, error: unknown): Promise<void> => {
		const retained = await retainWakeError(
			name,
			stage,
			new NotificationNotSentError('Notification inventory could not be read.', {
				cause: error,
			}),
		);
		if (retained.changed)
			console.error(`${name}: ${stage} remains queued; inspect own mail status.`);
	};
	// Unsent, then uncertain, then readiness: the order the final save has always used.
	const settledDelivery = async (
		failed: boolean,
		uncertain: boolean,
	): Promise<Pick<DeliveryState, 'reason' | 'state'>> => {
		if (failed) return { state: 'queued-only', reason: unsentReason };
		if (uncertain) return { state: 'queued-only', reason: uncertainReason };
		return (await optionalText(join(runtimePath(name), `${nonce}.ready`))) === nonce
			? { state: 'live', reason: confirmedReason }
			: { state: 'unconfirmed', reason: awaitingReadinessReason };
	};
	// What this cycle and this launch's retained records still report, in the final save's order:
	// an inventory failure (this cycle's, or an unrecovered inventory or room-policy episode), then an
	// unsent, then an uncertain outcome. Episodes from other launches are not counted.
	const retainedProblem = async (inventoryFailed: boolean): Promise<string | undefined> => {
		if (inventoryFailed) return inventoryReason;
		const episodes = await wakeErrors(name);
		if (
			episodes.some(
				(episode) =>
					!episode.recoveredAt &&
					episode.observedNonce === nonce &&
					inventoryStages.has(episode.stage),
			)
		)
			return inventoryReason;
		const retained = retainedOutcome(await wakeDeliveryRetained(name, nonce));
		if (retained.failed) return unsentReason;
		if (retained.uncertain) return uncertainReason;
		return undefined;
	};
	// A held reason is written only when it changes (saveDelivery compares). It carries any problem
	// the records still report, and when the hold clears, such as a turn now busy, the status
	// returns to that problem rather than to readiness alone.
	const recordNoticeHold = async (inventoryFailed = false): Promise<void> => {
		const hold = await options.noticeHold?.(true);
		if (hold === undefined) return;
		const current = await deliveryStatus(name, nonce);
		if (hold === null && !current.reason.startsWith(noticesHeldPrefix)) return;
		const problem = await retainedProblem(inventoryFailed);
		if (hold !== null)
			await saveDelivery(name, {
				...current,
				state: 'queued-only',
				reason: problem ? `${hold} ${problem}` : hold,
			});
		else
			await saveDelivery(name, {
				...current,
				...(problem
					? { state: 'queued-only', reason: problem }
					: await settledDelivery(false, false)),
			});
	};
	return async () => {
		if (!active() || !(await owns())) return;
		await trackResponseSafely(name, () => evaluateResponseWatchdog(name, nonce), true);
		// Import authenticated remote halt/proceed even while ordinary notifications are paused.
		let telegramFailed = false;
		try {
			await pollWakeTelegram(name);
		} catch (error: unknown) {
			telegramFailed = true;
			await report('telegram inventory', error);
		}
		if ((await communicationState()).paused) return;
		if (await deliverHibernationControl(name, nonce, options.controlSend ?? send)) return;
		if (
			await deliverHeadDownResponse(
				name,
				nonce,
				send,
				async () =>
					active() &&
					(await owns()) &&
					(!options.noticeAllowed || (await options.noticeAllowed())),
			)
		)
			return;
		if (await automaticNoticeSuppressed(name)) return;
		if (
			!options.noticeCheckWhenPending &&
			options.noticeAllowed &&
			!(await options.noticeAllowed())
		) {
			await recordNoticeHold(telegramFailed);
			return;
		}
		// Addressed traffic bypasses routine selection, so validate its policy independently.
		// A successful addressed collector must not falsely recover a still-invalid policy.
		let roomPolicyFailed = false;
		try {
			await roomWakePolicy();
		} catch (error: unknown) {
			roomPolicyFailed = true;
			await report('room inventory', error);
		}
		let packet: CheckpointPackage | undefined;
		try {
			packet = await activeWakeReadBoundary(name, startedAt);
		} catch (error: unknown) {
			await report('checkpoint inventory', error);
			await saveDelivery(name, {
				...(await deliveryStatus(name, nonce)),
				state: 'queued-only',
				reason: 'Active checkpoint inventory is invalid; inspect own wake errors.',
			});
			return;
		}
		const sources: { stage: WakeStage; collect: () => Promise<WakePart | undefined> }[] = [
			{ stage: 'mail inventory', collect: () => prepareReadiness(name, nonce) },
			{
				stage: 'mail inventory',
				collect: () =>
					prepareMailNotice(name, nonce, packet, options.coalesceQueuedNotices),
			},
			{ stage: 'approval inventory', collect: () => prepareHoldNotice(name, nonce, packet) },
			{
				stage: 'room inventory',
				collect: () =>
					prepareLocalRoomNotice(name, nonce, packet, options.coalesceQueuedNotices),
			},
			{
				stage: 'telegram inventory',
				collect: () => prepareTelegramNotice(name, nonce, packet),
			},
		];
		const results = await Promise.allSettled(sources.map((source) => source.collect()));
		const parts: WakePart[] = [];
		let failed = telegramFailed || roomPolicyFailed;
		const readiness = results[0];
		// A new natural event repeats the unconfirmed nonce, without a readiness-only loop.
		if (
			options.readinessReminder !== false &&
			readiness?.status === 'fulfilled' &&
			!readiness.value &&
			results.slice(1).some((value) => value.status === 'fulfilled' && value.value)
		) {
			try {
				readiness.value = await prepareReadiness(name, nonce, true);
			} catch (reason: unknown) {
				results[0] = { status: 'rejected', reason };
			}
		}
		for (const [index, result] of results.entries()) {
			const source = sources[index];
			if (!source) throw new Error('Notification inventory source is missing.');
			if (result.status === 'rejected') {
				failed = true;
				await report(source.stage, result.reason);
			} else if (result.value) parts.push(result.value);
		}
		const inventoryFailed = failed;
		if (!active() || (await automaticNoticeSuppressed(name))) return;
		// Recover a stage only when every collector for that stage succeeded, including readiness.
		for (const stage of new Set(sources.map((source) => source.stage))) {
			if (
				!(stage === 'telegram inventory' && telegramFailed) &&
				!(stage === 'room inventory' && roomPolicyFailed) &&
				results.every(
					(result, index) =>
						sources[index]?.stage !== stage || result.status === 'fulfilled',
				)
			)
				await recoverWakeError(name, stage);
		}
		await recoverWakeError(name, 'checkpoint inventory');
		if (
			parts.length &&
			options.noticeCheckWhenPending &&
			options.noticeAllowed &&
			!(await options.noticeAllowed())
		) {
			await recordNoticeHold(inventoryFailed);
			return;
		}
		let result: 'none' | 'submitted' | 'uncertain' = 'none';
		try {
			result = await deliverWakeParts(name, nonce, parts, send, async () => {
				if (
					!active() ||
					!(await owns()) ||
					(options.noticeAllowed && !(await options.noticeAllowed()))
				)
					return false;
				const current = await activeWakeReadBoundary(name, startedAt);
				return !current || !parts.some((part) => wakePartCovered(part, current));
			});
		} catch (error: unknown) {
			if (!(error instanceof NotificationNotSentError)) throw error;
			failed = true;
		}
		const retained = retainedOutcome(await wakeDeliveryRetained(name, nonce));
		const uncertain = result === 'uncertain' || retained.uncertain;
		failed ||= retained.failed;
		if (!failed && !uncertain) {
			await recoverWakeError(name, 'receiver cycle');
			// A hold that stopped this cycle's notice stays the status; the generic outcome can't erase it.
			if (typeof (await options.noticeHold?.(parts.length > 0)) === 'string') {
				await recordNoticeHold();
				return;
			}
		}
		const settled = await settledDelivery(failed, uncertain);
		await saveDelivery(name, {
			...(await deliveryStatus(name, nonce)),
			state: settled.state,
			reason: roomPolicyFailed
				? 'Room wake policy is invalid or unreadable; routine notification eligibility is unknown. Inspect own wake errors and delivery outcome.'
				: inventoryFailed
					? inventoryReason
					: settled.reason,
		});
	};
}
