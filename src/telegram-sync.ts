import { join } from 'node:path';

import { applyTelegramSignal } from './communication-state.ts';
import { humanHibernationCommand } from './hibernation.ts';
import { atomicWrite, LockBusyError, locked, optionalText } from './mail-files.ts';
import { type TelegramConfig, telegramRequest, TelegramRequestError } from './telegram-api.ts';
import { recordTelegramHealth } from './telegram-health.ts';
import { recordRoomEvent, repairRoomMirrors, telegramRoot } from './telegram-room.ts';

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export async function syncTelegram(
	config: TelegramConfig,
	drain = false,
	minimumInterval = 0,
	local = false,
	onPollSuccess?: () => void,
): Promise<number> {
	if (!config.allowedUserIds.length)
		throw new Error(
			'Receiving Telegram requires allowedUserIds in telegram.json. Use Telegram user IDs, not agent names.',
		);
	const polledPath = join(telegramRoot(config), 'polled-at');
	const recent = async (): Promise<boolean> => {
		const polled = Number((await optionalText(polledPath)) ?? '0');
		return !drain && minimumInterval > 0 && Date.now() - polled < minimumInterval;
	};
	if (await recent()) return 0;
	const pollLock = join(telegramRoot(config), 'poll.lock');
	return locked(
		pollLock,
		async () => {
			if (await recent()) return 0;
			// Share the polling cadence across active receivers, including during API outages.
			await atomicWrite(polledPath, String(Date.now()));
			const offsetPath = join(telegramRoot(config), 'offset');
			let offset = Number((await optionalText(offsetPath)) ?? '0');
			if (!Number.isSafeInteger(offset) || offset < 0)
				throw new Error('Invalid Telegram update cursor.');
			let accepted = 0;
			for (let batch = 0; batch < 10; batch++) {
				const result = await telegramRequest(config, 'getUpdates', {
					offset,
					timeout: 0,
					limit: 100,
					allowed_updates: ['message'],
				}).catch(async (error: unknown) => {
					if (error instanceof TelegramRequestError)
						await recordTelegramHealth(config, error);
					throw error;
				});
				if (!Array.isArray(result)) throw new Error('Telegram returned invalid updates.');
				for (const item of result) {
					const update = object(item);
					if (
						!update ||
						!Number.isSafeInteger(update.update_id) ||
						Number(update.update_id) < 0
					)
						throw new Error('Telegram returned an invalid update ID.');
					if (Number(update.update_id) < offset) continue;
					const message = object(update.message);
					const chat = object(message?.chat);
					const sender = object(message?.from);
					if (
						message &&
						chat &&
						sender &&
						String(chat.id) === config.chatId &&
						sender.is_bot === false &&
						config.allowedUserIds.includes(String(sender.id)) &&
						!message.sender_chat &&
						!message.forward_origin &&
						typeof message.text === 'string' &&
						message.text.length <= 4096 &&
						Number.isSafeInteger(message.message_id) &&
						Number(message.message_id) > 0
					) {
						const reply = object(message.reply_to_message);
						await humanHibernationCommand(message.text, Number(message.date) * 1000);
						await applyTelegramSignal(
							config.botToken.split(':')[0] ?? '',
							Number(update.update_id),
							message.date,
							message.text,
							String(sender.id),
						);
						await recordRoomEvent(config, {
							messageId: Number(message.message_id),
							sender: { kind: 'user', id: String(sender.id) },
							text: message.text,
							replyTo: Number.isSafeInteger(reply?.message_id)
								? Number(reply?.message_id)
								: null,
						});
						accepted++;
					}
					offset = Number(update.update_id) + 1;
					// Persist only after the event is durable; a crash replays safely by message ID.
					await atomicWrite(offsetPath, String(offset));
				}
				if (!drain || result.length < 100) {
					await repairRoomMirrors(config);
					await recordTelegramHealth(config);
					onPollSuccess?.();
					return accepted;
				}
			}
			throw new Error('Telegram backlog is not drained; sync again before sending.');
		},
		local ? 40 : drain ? 800 : 1,
	).catch((error: unknown) => {
		// Another receiver owns the refresh. Reads can use the durable history meanwhile.
		// Local consumers need an explicit busy diagnostic rather than implied freshness.
		if (!drain && !local && error instanceof LockBusyError && error.path === pollLock) return 0;
		throw error;
	});
}
