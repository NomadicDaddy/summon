import { nextLocalRoomWakeAt } from './local-room-live.ts';
import { operatorViewExpiry } from './operator-view.ts';
import { RETRY_CLOCK_GUARD_MS } from './receiver-cadence.ts';
import { responseEpisodeDeadline } from './response-watchdog-model.ts';
import { responseStatus } from './response-watchdog-store.ts';
import { nextTelegramRoomWakeAt } from './telegram-live.ts';
import { nextWakeRetryAt } from './wake-delivery-store.ts';

/** Keep deadlines crossed during a cycle for an immediate follow-up. */
export async function nextReceiverDeadline(
	name: string,
	nonce: string,
	now = Date.now(),
	cycleStartedAt = now,
): Promise<number | undefined> {
	const [retry, response, viewExpiry] = await Promise.all([
		nextWakeRetryAt(name, nonce),
		responseStatus(name, nonce),
		operatorViewExpiry(name, cycleStartedAt),
	]);
	const deadlines = [
		retry === undefined
			? undefined
			: retry <= cycleStartedAt
				? now + RETRY_CLOCK_GUARD_MS
				: Math.min(retry, now + RETRY_CLOCK_GUARD_MS),
		viewExpiry,
		nextLocalRoomWakeAt(cycleStartedAt),
		nextTelegramRoomWakeAt(cycleStartedAt),
	];
	if (response) deadlines.push(responseEpisodeDeadline(response, cycleStartedAt));
	const future = deadlines.filter((at): at is number => at !== undefined && at > cycleStartedAt);
	return future.length ? Math.min(...future) : undefined;
}
