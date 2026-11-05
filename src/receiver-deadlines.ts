import { nextLocalRoomWakeAt } from './local-room-live.ts';
import { operatorViewExpiry } from './operator-view.ts';
import { RETRY_CLOCK_GUARD_MS } from './receiver-cadence.ts';
import { responseEpisodeDeadline } from './response-watchdog-model.ts';
import { responseStatus } from './response-watchdog-store.ts';
import { nextTelegramRoomWakeAt } from './telegram-live.ts';
import { nextWakeRetryAt } from './wake-delivery-store.ts';

/** Future deadlines only. An already due item was handled by the just-completed cycle. */
export async function nextReceiverDeadline(
	name: string,
	nonce: string,
	now = Date.now(),
): Promise<number | undefined> {
	const [retry, response, viewExpiry] = await Promise.all([
		nextWakeRetryAt(name, nonce),
		responseStatus(name, nonce),
		operatorViewExpiry(name, now),
	]);
	const deadlines = [
		retry === undefined
			? undefined
			: retry <= now
				? now + RETRY_CLOCK_GUARD_MS
				: Math.min(retry, now + RETRY_CLOCK_GUARD_MS),
		viewExpiry,
		nextLocalRoomWakeAt(now),
		nextTelegramRoomWakeAt(now),
	];
	if (response) deadlines.push(responseEpisodeDeadline(response, now));
	const future = deadlines.filter((at): at is number => at !== undefined && at > now);
	return future.length ? Math.min(...future) : undefined;
}
