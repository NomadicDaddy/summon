import { communicationSend } from './communication-gate.ts';
import { communicationState } from './communication-state.ts';
import { localEvents } from './local-room.ts';
import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { currentAgent, operatorOnly } from './mail-identity.ts';
import { roomCursor as integer } from './room-cursor.ts';
import { loadAgent } from './store.ts';
import { telegramConfig, type TelegramConfig, telegramRequest } from './telegram-api.ts';
import { roomCursorPath as cursorPath, roomDeliveryStatus } from './telegram-live.ts';
import { recordRoomEvent, type RoomEvent, roomEvents } from './telegram-room.ts';
import { syncTelegram } from './telegram-sync.ts';

const usage =
	'Usage: summon --telegram status | send [--to-user] <text> | reply [--to-user] <message-id> <text> | read [cursor] | ack <cursor> | sync | watch';
async function agent(): Promise<string> {
	const slug = currentAgent();
	if (!(await loadAgent(slug))) throw new Error('Telegram requires a registered summon agent.');
	return slug;
}
export async function readRoom(
	config: TelegramConfig,
	after?: string,
	compact = false,
): Promise<{
	paused: boolean;
	events: RoomEvent[];
	nextCursor: number;
	more: boolean;
}> {
	const slug = await agent();
	await syncTelegram(config);
	const cursor = integer(after ?? (await optionalText(cursorPath(config, slug))) ?? '0');
	const remaining = (await roomEvents(config)).filter((event) => event.sequence > cursor);
	const events: RoomEvent[] = [];
	let size = 0;
	for (const event of remaining) {
		const item: RoomEvent = {
			sequence: event.sequence,
			messageId: event.messageId,
			sender: event.sender,
			text:
				compact && event.sender.kind === 'agent' && event.sender.id === slug
					? ''
					: event.text,
			replyTo: event.replyTo,
		};
		const length = Buffer.byteLength(JSON.stringify(item));
		if (events.length >= 20 || size + length > 28000) break;
		events.push(item);
		size += length;
	}
	return {
		paused: (await communicationState()).paused,
		events,
		nextCursor: events.at(-1)?.sequence ?? cursor,
		more: remaining.length > events.length,
	};
}

export async function ackRoom(config: TelegramConfig, value: string): Promise<number> {
	const slug = await agent();
	const cursor = integer(value);
	if (cursor > ((await roomEvents(config)).at(-1)?.sequence ?? 0))
		throw new Error('Cursor exceeds room history.');
	const path = cursorPath(config, slug);
	await locked(`${path}.lock`, async () => {
		const previous = integer((await optionalText(path)) ?? '0');
		await atomicWrite(path, String(Math.max(previous, cursor)));
	});
	return cursor;
}

async function send(
	config: TelegramConfig,
	text: string,
	replyTo: number | null,
	toUser: boolean,
	localReplyTo?: number,
): Promise<void> {
	const slug = await agent();
	if (!text.trim()) throw new Error(usage);
	const heading = `📣 FOR YOU · ${slug}`;
	const labelled = toUser ? `${heading}\n\n${text.trim()}` : `[${slug}] ${text.trim()}`;
	if (labelled.length > 4096)
		throw new Error('Telegram message including agent label exceeds 4096 characters.');
	if (
		replyTo !== null &&
		!(await roomEvents(config)).some((event) => event.messageId === replyTo)
	)
		throw new Error('Reply target is not in this room history. Read the room first.');
	const result = await communicationSend('send the Telegram message', () =>
		telegramRequest(config, 'sendMessage', {
			chat_id: config.chatId,
			text: labelled,
			...(toUser ? { entities: [{ type: 'bold', offset: 0, length: heading.length }] } : {}),
			link_preview_options: { is_disabled: true },
			...(replyTo === null ? {} : { reply_parameters: { message_id: replyTo } }),
		}),
	);
	if (
		!result ||
		typeof result !== 'object' ||
		!('message_id' in result) ||
		!Number.isSafeInteger(result.message_id) ||
		Number(result.message_id) <= 0
	)
		throw new Error('Telegram returned an unexpected receipt. Check the chat before retrying.');
	try {
		await recordRoomEvent(config, {
			messageId: Number(result.message_id),
			sender: { kind: 'agent', id: slug },
			text: toUser ? `📣 FOR YOU\n\n${text.trim()}` : text.trim(),
			replyTo,
			...(localReplyTo === undefined ? {} : { localReplyTo }),
		});
	} catch {
		const recorded = await roomEvents(config)
			.then((events) => events.some((event) => event.messageId === Number(result.message_id)))
			.catch(() => false);
		throw new Error(
			`Telegram accepted message ${String(result.message_id)}. Do not resend. ${
				recorded
					? 'It is recorded in Telegram history and will be mirrored into the local room on the next successful sync.'
					: 'Shared history recording could not be confirmed; check Telegram before any recovery.'
			}`,
		);
	}
	console.log(
		`Telegram accepted message ${String(result.message_id)} from ${slug}. This does not confirm it was read.`,
	);
}

/** Local and Telegram reply identifiers belong to separate namespaces. */
export async function sendRoomReply(localReplyTo: number, text: string): Promise<void> {
	const target = (await localEvents()).find((event) => event.id === localReplyTo);
	if (!target) throw new Error('Reply target is not in the local room.');
	const config = await telegramConfig();
	const prefix = `telegram:${config.botToken.split(':')[0]}:${config.chatId}:`;
	const telegramTarget = (await roomEvents(config)).find(
		(event) => target.source === `${prefix}${event.messageId}`,
	);
	await send(config, text, telegramTarget?.messageId ?? null, true, localReplyTo);
}

async function watch(config: TelegramConfig): Promise<void> {
	operatorOnly();
	const controller = new AbortController();
	const stopped = (): boolean => controller.signal.aborted;
	const stop = (): void => {
		controller.abort();
	};
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
	console.log('Telegram room bridge running. Ctrl+C stops it; no agents are launched.');
	let failures = 0;
	let lastError = '';
	try {
		while (!stopped()) {
			let wait = 2000;
			try {
				const count = await syncTelegram(config);
				if (count) console.log(`Recorded ${count} room message(s).`);
				failures = 0;
				lastError = '';
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				if (message !== lastError) console.error(message);
				lastError = message;
				wait = [2000, 5000, 15000][failures++] ?? 60000;
			}
			const until = Date.now() + wait;
			while (!stopped() && Date.now() < until) await Bun.sleep(100);
		}
	} finally {
		process.off('SIGINT', stop);
		process.off('SIGTERM', stop);
	}
}

export async function telegramCommand(args: string[]): Promise<void> {
	const toUser = (args[0] === 'send' || args[0] === 'reply') && args[1] === '--to-user';
	if (toUser) args = [args[0] ?? '', ...args.slice(2)];
	const [action, first, second] = args;
	if (
		(action === 'send' && args.length === 2 && first?.trim()) ||
		(action === 'reply' && args.length === 3 && first && second?.trim())
	) {
		await send(
			await telegramConfig(),
			action === 'send' ? first : (second ?? ''),
			action === 'reply' ? integer(first) : null,
			toUser,
		);
		return;
	}
	if (action === 'read' && args.length <= 2) {
		console.log(JSON.stringify(await readRoom(await telegramConfig(), first)));
		return;
	}
	if (action === 'ack' && args.length === 2 && first) {
		const cursor = await ackRoom(await telegramConfig(), first);
		console.log(`Room read through ${cursor}. This does not mean work was performed.`);
		return;
	}
	if (args.length === 1 && action === 'status') {
		const config = await telegramConfig();
		console.log(
			`Telegram configured for ${Number(config.chatId) > 0 ? 'your existing private bot chat' : 'a group room'}. Credentials and connectivity have not been verified.`,
		);
		console.log(
			config.allowedUserIds.length
				? 'Inbound room reads enabled for configured users.'
				: 'Set allowedUserIds before receiving group messages.',
		);
		if (process.env.SUMMON_AGENT && process.env.SUMMON_NONCE)
			console.log(await roomDeliveryStatus(config, currentAgent(), process.env.SUMMON_NONCE));
		return;
	}
	if (args.length === 1 && action === 'sync') {
		operatorOnly();
		console.log(`Recorded ${await syncTelegram(await telegramConfig())} room message(s).`);
		return;
	}
	if (args.length === 1 && action === 'watch') {
		await watch(await telegramConfig());
		return;
	}
	throw new Error(usage);
}
