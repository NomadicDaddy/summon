import { readActivity } from './agent-activity.ts';
import { claudeNoticeHold } from './claude-notice-hold.ts';
import { claudeNoticeAllowed, reserveClaudeNotice } from './claude-turn-state.ts';
import { startMailWatcher } from './mail-watcher.ts';
import { NotificationNotSentError } from './notification-delivery.ts';

/** Reserve before the channel write; an uncertain transport write never restores idle. */
export function startClaudeChannel(
	name: string,
	nonce: string,
	send: (text: string) => Promise<void>,
): Promise<() => Promise<void>> {
	return startMailWatcher(
		name,
		nonce,
		async (text) => {
			let rollback: () => Promise<void>;
			try {
				rollback = await reserveClaudeNotice(name, nonce);
			} catch (error: unknown) {
				throw new NotificationNotSentError('Claude awaits verified native completion.', {
					cause: error,
				});
			}
			try {
				await send(text);
			} catch (error: unknown) {
				if (error instanceof NotificationNotSentError) await rollback();
				throw error;
			}
		},
		{
			controlSend: send,
			readinessReminder: false,
			noticeAllowed: () => claudeNoticeAllowed(name, nonce),
			// A held live-channel seat says why, as a terminal seat does; only its own launch reports.
			noticeHold: async () => {
				if ((await readActivity(name))?.nonce !== nonce) return undefined;
				return (await claudeNoticeHold(name, nonce)) ?? null;
			},
		},
	);
}
