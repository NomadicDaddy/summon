import type { readLocalRoom } from './local-room-access.ts';
import type { TelegramConfig } from './telegram-api.ts';
import type { readRoom } from './telegram.ts';

type LocalPage = Awaited<ReturnType<typeof readLocalRoom>>;
type TelegramPage = Awaited<ReturnType<typeof readRoom>>;

/** Retain both transport addresses; omit a body only when this batch delivers its exact mirror. */
export function checkpointMirrors(room: LocalPage, telegram: TelegramPage, config: TelegramConfig) {
	const prefix = `telegram:${config.botToken.split(':')[0]}:${config.chatId}:`;
	return {
		...telegram,
		events: telegram.events.map((event) => {
			const mirror = room.events.find(
				(local) =>
					local.source === `${prefix}${event.messageId}` &&
					local.text === event.text &&
					local.sender.kind === event.sender.kind &&
					local.sender.id === event.sender.id,
			);
			return mirror && event.text ? { ...event, text: '', bodyInRoom: mirror.id } : event;
		}),
	};
}
