import { join } from 'node:path';

import type { TelegramConfig } from './telegram-api.ts';

import { appendLocalEvent, localEvents } from './local-room.ts';
import { atomicWrite, locked, optionalText } from './mail-files.ts';
import {
	type PresenceResolver,
	resolveRoomGroups,
	type RoomGroups,
	validRoomGroups,
} from './room-groups.ts';
import { storageRoot } from './store.ts';

export interface RoomEvent {
	sequence: number;
	messageId: number;
	sender: { kind: 'user' | 'agent'; id: string };
	text: string;
	replyTo: number | null;
	localReplyTo?: number;
	mirrorPending?: true;
	groups?: RoomGroups;
}
interface RoomState {
	events: RoomEvent[];
}

export function telegramRoot(config: TelegramConfig): string {
	return join(
		storageRoot(),
		'integrations',
		'telegram-state',
		config.botToken.split(':')[0] ?? '',
	);
}
export function roomRoot(config: TelegramConfig): string {
	return join(telegramRoot(config), config.chatId);
}
async function state(config: TelegramConfig): Promise<RoomState> {
	const raw = await optionalText(join(roomRoot(config), 'events.json'));
	if (!raw) return { events: [] };
	const value: unknown = JSON.parse(raw);
	if (
		!value ||
		typeof value !== 'object' ||
		!('events' in value) ||
		!Array.isArray(value.events) ||
		!value.events.every(validEvent)
	)
		throw new Error('Invalid Telegram room history.');
	return { events: value.events };
}
function validEvent(value: unknown): value is RoomEvent {
	if (!value || typeof value !== 'object') return false;
	const event = value as Record<string, unknown>;
	const sender = event.sender;
	return (
		Number.isSafeInteger(event.sequence) &&
		Number(event.sequence) > 0 &&
		Number.isSafeInteger(event.messageId) &&
		Number(event.messageId) > 0 &&
		typeof event.text === 'string' &&
		!!sender &&
		typeof sender === 'object' &&
		'kind' in sender &&
		(sender.kind === 'agent' || sender.kind === 'user') &&
		'id' in sender &&
		typeof sender.id === 'string' &&
		(event.mirrorPending === undefined || event.mirrorPending === true) &&
		(event.localReplyTo === undefined ||
			(Number.isSafeInteger(event.localReplyTo) && Number(event.localReplyTo) > 0)) &&
		validRoomGroups(event.groups) &&
		(event.replyTo === null || Number.isSafeInteger(event.replyTo))
	);
}
export async function roomEvents(config: TelegramConfig): Promise<RoomEvent[]> {
	return (await state(config)).events;
}
/** Every teammate reads the same conversation; receipts preserve identity across repeated updates. */
export async function recordRoomEvent(
	config: TelegramConfig,
	input: Pick<RoomEvent, 'messageId' | 'sender' | 'text' | 'replyTo' | 'localReplyTo'>,
	resolvePresence?: PresenceResolver,
): Promise<RoomEvent> {
	// Resolved once, outside the lock; the local mirror reuses these groups rather than reading
	// presence again, so both rooms address the same members.
	const groups = await resolveRoomGroups(input.text, input.sender, resolvePresence);
	return locked(join(roomRoot(config), 'write.lock'), async () => {
		const history = await state(config);
		const existing = history.events.find((event) => event.messageId === input.messageId);
		if (existing) {
			await mirror(existing, config);
			if (existing.mirrorPending) {
				delete existing.mirrorPending;
				await atomicWrite(join(roomRoot(config), 'events.json'), JSON.stringify(history));
			}
			return existing;
		}
		const event: RoomEvent = {
			...input,
			...(groups ? { groups } : {}),
			sequence: history.events.length + 1,
			mirrorPending: true,
		};
		history.events.push(event);
		await atomicWrite(join(roomRoot(config), 'events.json'), JSON.stringify(history));
		await mirror(event, config);
		delete event.mirrorPending;
		await atomicWrite(join(roomRoot(config), 'events.json'), JSON.stringify(history));
		return event;
	});
}

async function mirror(event: RoomEvent, config: TelegramConfig): Promise<void> {
	const prefix = `telegram:${config.botToken.split(':')[0]}:${config.chatId}:`;
	const reply =
		event.replyTo === null
			? undefined
			: (await localEvents()).find((item) => item.source === `${prefix}${event.replyTo}`);
	await appendLocalEvent({
		sender: event.sender,
		text: event.text,
		replyTo: event.localReplyTo ?? reply?.id ?? null,
		source: `${prefix}${event.messageId}`,
		...(event.groups ? { groups: event.groups } : {}),
	});
}

/** Outbound bot messages never return through getUpdates, so repair their local mirrors. */
export async function repairRoomMirrors(config: TelegramConfig): Promise<void> {
	for (const event of await roomEvents(config)) {
		if (event.sender.kind === 'agent' && event.mirrorPending) {
			await recordRoomEvent(config, event);
		}
	}
}
