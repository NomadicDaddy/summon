import type { WakeOutcome } from './wake-delivery-store.ts';
import type { WakeBoundary } from './wake-failure.ts';
import type { WakePart, WakeSend } from './wake-part.ts';

import { assertAutomaticNoticeAllowed } from './automatic-notice.ts';
import { checkpointHash } from './checkpoint-package-model.ts';
import { locked } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { NotificationNotSentError } from './notification-delivery.ts';
import { trackResponseSafely } from './response-watchdog-safety.ts';
import { recordResponseAttempt } from './response-watchdog.ts';
import {
	loadWakeOutcome,
	normalized,
	outcomePath,
	saveWakeOutcome,
} from './wake-delivery-store.ts';
import { recordWakeFailure } from './wake-failure.ts';

/** The receiver owns serialization; retention precedes input and uncertain attempts never retry. */
export async function deliverWakeParts(
	name: string,
	nonce: string,
	parts: WakePart[],
	send: WakeSend,
	allowed: () => Promise<boolean>,
): Promise<'none' | 'submitted' | 'uncertain'> {
	ownMailbox(name);
	const selected: WakePart[] = [];
	for (const part of parts)
		if ((await part.needed()) && !(await part.acknowledged())) selected.push(part);
	if (!selected.length) return 'none';
	const targets = normalized(selected.map((part) => part.target));
	const id = checkpointHash([name, nonce, targets]);
	return locked(`${outcomePath(name, id)}.lock`, async () => {
		const previous = await loadWakeOutcome(name, nonce, id);
		if (previous && !['not-sent', 'suppressed'].includes(previous.state)) return 'none';
		if (previous && previous.retryAt > Date.now()) return 'none';
		const now = new Date().toISOString();
		const value: WakeOutcome = {
			version: 1,
			id,
			owner: name,
			nonce,
			targets,
			state: 'attempted',
			stage: 'notification delivery',
			attempts: (previous?.attempts ?? 0) + 1,
			retryAt: 0,
			createdAt: previous?.createdAt ?? now,
			updatedAt: now,
			...(previous?.failedAt ? { failedAt: previous.failedAt } : {}),
			...(previous?.lastFailureAt ? { lastFailureAt: previous.lastFailureAt } : {}),
		};
		await saveWakeOutcome(value);
		const track = (condition: 'uncertain' | 'awaiting-read' | 'blocked') =>
			trackResponseSafely(name, () =>
				recordResponseAttempt(name, nonce, targets, condition, id),
			);
		let inputStarted = false;
		// The step about to run, so a failure names the call boundary that threw.
		let boundary: WakeBoundary = 'watchdog-retention';
		try {
			// Both records precede input. A caught retention refusal is definitely unsent;
			// a process crash still leaves the attempted outcome in place without replay.
			await recordResponseAttempt(name, nonce, targets, 'uncertain', id);
			boundary = 'mark-attempted';
			for (const part of selected) await part.mark('attempted');
			boundary = 'ownership-boundary';
			if (!(await allowed()))
				throw new NotificationNotSentError('Receiver ownership or read boundary changed.');
			boundary = 'other';
			for (const part of selected) {
				if (!(await part.needed()) || (await part.acknowledged())) {
					// No input has happened. Retain this as suppression, not a read acknowledgment.
					value.state = 'suppressed';
					value.updatedAt = new Date().toISOString();
					await saveWakeOutcome(value);
					for (const pending of selected) await pending.mark('deferred');
					await track('blocked');
					return 'none';
				}
			}
			boundary = 'notice-paused';
			await assertAutomaticNoticeAllowed(name);
			inputStarted = true;
			boundary = 'send';
			await send(selected.map((part) => part.text).join('\n'), async () => {
				if (!(await allowed())) return false;
				for (const part of selected)
					if (!(await part.needed()) || (await part.acknowledged())) return false;
				await assertAutomaticNoticeAllowed(name);
				return true;
			});
			boundary = 'after-send';
			value.state = 'provider-submitted';
			value.updatedAt = new Date().toISOString();
			if (value.failedAt) value.recoveredAt = value.updatedAt;
			await saveWakeOutcome(value);
			for (const part of selected) await part.mark('queued');
			await track('awaiting-read');
			return 'submitted';
		} catch (error: unknown) {
			const unsent = !inputStarted || error instanceof NotificationNotSentError;
			value.state = unsent ? 'not-sent' : 'uncertain';
			value.updatedAt = new Date().toISOString();
			value.failedAt ??= value.updatedAt;
			value.lastFailureAt = value.updatedAt;
			value.retryAt = unsent
				? Date.now() + ([2000, 5000, 15000][value.attempts - 1] ?? 60000)
				: 0;
			await saveWakeOutcome(value);
			await recordWakeFailure(value, boundary, error);
			for (const part of selected) await part.mark(unsent ? 'deferred' : 'failed');
			await track(unsent ? 'blocked' : 'uncertain');
			if (unsent)
				throw new NotificationNotSentError(
					'Automatic notice was not sent; it remains queued.',
					{ cause: error },
				);
			return 'uncertain';
		}
	});
}
