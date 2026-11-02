import { join } from 'node:path';

import { assertCommunicationsOpen } from './communication-state.ts';
import { optionalText } from './mail-files.ts';
import { storageRoot } from './store.ts';
import { telegramConfig, TelegramRequestError } from './telegram-api.ts';
import { refreshTelegramForLocal } from './telegram-local-refresh.ts';
import { syncTelegram } from './telegram-sync.ts';

type CommunicationOperation =
	| 'add the Board comment'
	| 'post the Room question'
	| 'save the Board change'
	| 'save the Diary entry'
	| 'send the mail message'
	| 'send the Room post'
	| 'send the Telegram message';

function refreshReason(error: unknown): string {
	if (error instanceof TelegramRequestError) return error.reason;
	const details = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
	if (details.code === 'EACCES' || details.code === 'EPERM')
		return 'Permission was denied while accessing local halt-state data.';
	const safeMessages = new Set([
		'Invalid Telegram update cursor.',
		'Telegram returned invalid updates.',
		'Telegram returned an invalid update ID.',
		'Invalid Telegram configuration JSON.',
		'Invalid Telegram configuration.',
		'Telegram configuration requires botToken and numeric chatId strings.',
		'Telegram allowedUserIds must be an array of numeric user ID strings.',
		'Group chats require allowedUserIds in telegram.json.',
	]);
	return typeof details.message === 'string' && safeMessages.has(details.message)
		? details.message
		: 'Telegram halt-state refresh failed unexpectedly.';
}

export class CommunicationRefreshError extends Error {
	constructor(operation: CommunicationOperation, error: unknown) {
		const reason = refreshReason(error);
		super(
			`Could not check Telegram halt/proceed state, so Summon did not ${operation}. Reason: ${reason}`,
			{ cause: new Error(reason) },
		);
		this.name = 'CommunicationRefreshError';
	}
}

/** Refresh human signals before sending, then check the shared latch at the send boundary. */
export async function communicationSend<T>(
	operation: CommunicationOperation,
	send: () => Promise<T>,
): Promise<T> {
	// Poll even while paused: authenticated proceed is the only remote way to resume.
	try {
		if (await optionalText(join(storageRoot(), 'integrations', 'telegram.json'))) {
			const config = await telegramConfig();
			if (operation === 'send the Telegram message') await syncTelegram(config, true);
			else
				await refreshTelegramForLocal(config, true, (reason) => {
					console.warn(
						`Telegram refresh incomplete: ${reason} Local work uses the recorded communication state; remote halt/proceed updates may be pending.`,
					);
				});
		}
	} catch (error: unknown) {
		throw new CommunicationRefreshError(operation, error);
	}
	await assertCommunicationsOpen();
	return send();
}
