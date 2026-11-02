import { join } from 'node:path';

import type { CheckpointPackage } from './checkpoint-package-model.ts';
import type { WakePart } from './wake-part.ts';

import { checkpointHash } from './checkpoint-package-model.ts';
import { CHECKPOINT_NOTICE_INSTRUCTION } from './checkpoint-work.ts';
import { atomicWrite, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { runtimePath } from './mail-session.ts';
import { roomCache } from './room-cache.ts';
import { currentRoomRequest } from './room-current-request.ts';
import { receivesRoutineRoom } from './room-wake-policy.ts';
import {
	type RoomWakeBatch,
	roomWakeCauses,
	roomWakeDue,
	trackRoomWakeBatch,
	wakeCauseText,
} from './room-wake.ts';
import { storageRoot } from './store.ts';
import { telegramConfig, type TelegramConfig } from './telegram-api.ts';
import { type RoomEvent, roomEvents, roomRoot } from './telegram-room.ts';
import { syncTelegram } from './telegram-sync.ts';

const cachedEvents = roomCache<RoomEvent[]>();
const batches = new Map<string, RoomWakeBatch>();

export function roomCursorPath(config: TelegramConfig, name: string): string {
	return join(
		runtimePath(name),
		`telegram-${config.botToken.split(':')[0]}-${config.chatId}.cursor`,
	);
}

function noticePath(config: TelegramConfig, name: string, nonce: string): string {
	if (!/^[a-z0-9-]+$/i.test(nonce)) throw new Error('Invalid launch nonce.');
	return join(
		runtimePath(name),
		`${nonce}-telegram-${config.botToken.split(':')[0]}-${config.chatId}.notice`,
	);
}

interface Notice {
	through: number;
	state: 'attempted' | 'queued' | 'failed' | 'deferred';
}

async function notice(config: TelegramConfig, name: string, nonce: string): Promise<Notice> {
	const raw = await optionalText(noticePath(config, name, nonce));
	if (!raw) return { through: 0, state: 'attempted' };
	const value: unknown = JSON.parse(raw);
	if (
		!value ||
		typeof value !== 'object' ||
		!('through' in value) ||
		!Number.isSafeInteger(value.through) ||
		Number(value.through) < 0 ||
		!('state' in value) ||
		!['attempted', 'queued', 'failed', 'deferred'].includes(String(value.state))
	)
		throw new Error('Invalid Telegram notification state.');
	return value as Notice;
}

export async function roomDeliveryStatus(
	config: TelegramConfig,
	name: string,
	nonce: string,
): Promise<string> {
	ownMailbox(name);
	const latest = await notice(config, name, nonce);
	if (!latest.through)
		return 'No room notification attempted in this session; checkpoint reads remain available.';
	const read = roomCursor((await optionalText(roomCursorPath(config, name))) ?? '0');
	if (read >= latest.through)
		return `Room reading acknowledged through notification ${latest.through}; not proof of completed work.`;
	return `Room notification through ${latest.through}: ${latest.state}; reading is unconfirmed. Use summon --telegram read.`;
}

/** A receiver wakes its own active provider; it never starts providers or sends room replies. */
export async function pollWakeTelegram(name: string): Promise<void> {
	ownMailbox(name);
	if (await optionalText(join(storageRoot(), 'integrations', 'telegram.json')))
		await syncTelegram(await telegramConfig(), false, 2000);
}

export async function prepareTelegramNotice(
	name: string,
	nonce: string,
	packet?: CheckpointPackage,
): Promise<WakePart | undefined> {
	ownMailbox(name);
	if (!(await optionalText(join(storageRoot(), 'integrations', 'telegram.json')))) return;
	const config = await telegramConfig();
	const key = checkpointHash([config.botToken.split(':')[0], config.chatId]);
	const previous = await notice(config, name, nonce);
	const read = roomCursor((await optionalText(roomCursorPath(config, name))) ?? '0');
	if (!Number.isSafeInteger(read) || read < 0) throw new Error('Invalid Telegram read cursor.');
	const notified = previous.state === 'deferred' ? 0 : previous.through;
	const history = await cachedEvents(join(roomRoot(config), 'events.json'), () =>
		roomEvents(config),
	);
	const covered = packet?.sources.telegram?.key === key ? packet.sources.telegram.through : 0;
	const unread = history.filter(
		(event) =>
			event.sequence > Math.max(read, notified, covered) &&
			!(event.sender.kind === 'agent' && event.sender.id === name),
	);
	const through = unread.at(-1)?.sequence;
	const path = noticePath(config, name, nonce);
	if (through === undefined) {
		batches.delete(path);
		return;
	}
	const ownIds = new Set(
		history
			.filter((event) => event.sender.kind === 'agent' && event.sender.id === name)
			.map((event) => event.messageId),
	);
	const causes = roomWakeCauses(name, unread, ownIds).map((event) => event.sequence);
	if (causes.length === 0 && !(await receivesRoutineRoom(name))) return;
	const batch = trackRoomWakeBatch(batches, path, through);
	if (!roomWakeDue(batch)) return;
	batches.delete(path);
	const acknowledged = async (): Promise<boolean> =>
		roomCursor((await optionalText(roomCursorPath(config, name))) ?? '0') >= through;
	return {
		target: { source: 'telegram', key, through, ids: [] },
		text:
			wakeCauseText('Telegram', through, causes) +
			CHECKPOINT_NOTICE_INSTRUCTION +
			(await currentRoomRequest(name)),
		needed: async () => {
			const current = await telegramConfig();
			return (
				checkpointHash([current.botToken.split(':')[0], current.chatId]) === key &&
				!(await acknowledged())
			);
		},
		acknowledged,
		mark: async (state) => {
			await atomicWrite(path, JSON.stringify({ through, state }));
		},
	};
}
import { roomCursor } from './room-cursor.ts';
