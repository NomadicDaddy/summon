import { join } from 'node:path';

import type { TelegramConfig } from './telegram-api.ts';

import { LockBusyError } from './mail-files.ts';
import { TelegramRequestError } from './telegram-api.ts';
import { telegramRoot } from './telegram-room.ts';
import { syncTelegram } from './telegram-sync.ts';

/** Why a refresh could not complete: another process held the poll lock, or the request failed. */
export type TelegramUnavailable = 'refresh-busy' | 'request-failed';

export const TELEGRAM_REFRESH_BUSY_REASON =
	'Another Telegram refresh is still in progress after a short wait; using recorded state.';

/** A remote outage cannot veto local work. Local state/configuration errors still propagate. */
export async function refreshTelegramForLocal(
	config: TelegramConfig,
	drain: boolean,
	onUnavailable: (reason: string, kind: TelegramUnavailable) => void,
): Promise<void> {
	try {
		await syncTelegram(config, drain, 0, true);
	} catch (error: unknown) {
		if (
			error instanceof LockBusyError &&
			error.path === join(telegramRoot(config), 'poll.lock')
		) {
			onUnavailable(TELEGRAM_REFRESH_BUSY_REASON, 'refresh-busy');
			return;
		}
		if (!(error instanceof TelegramRequestError)) throw error;
		onUnavailable(error.reason, 'request-failed');
	}
}
