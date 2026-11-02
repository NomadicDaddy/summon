import { automaticInterruptionsPaused } from './automatic-interruptions.ts';
import { communicationState } from './communication-state.ts';
import { isHibernated } from './hibernation.ts';
import { assertNotificationOpen, NotificationNotSentError } from './notification-delivery.ts';
import { restSuppressed } from './rest.ts';

/** All automatic transports retain their work while these operator/session gates are closed. */
export async function automaticNoticeSuppressed(name: string): Promise<boolean> {
	return (
		(await communicationState()).paused ||
		(await isHibernated(name)) ||
		(await automaticInterruptionsPaused(name)) ||
		(await restSuppressed(name))
	);
}

/** Recheck immediately before input; a blocked ordinary wake is definitely unsent. */
export async function assertAutomaticNoticeAllowed(name: string): Promise<void> {
	await assertNotificationOpen();
	if (await automaticNoticeSuppressed(name))
		throw new NotificationNotSentError('Automatic notice waits for the session pause gate.');
}
