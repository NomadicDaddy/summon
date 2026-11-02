import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import type { CheckpointPackage, CheckpointState } from './checkpoint-package-model.ts';
import type { CheckpointInput } from './checkpoint-package-pages.ts';
import type { TelegramConfig } from './telegram-api.ts';

import { checkpointHash } from './checkpoint-package-model.ts';
import { checkpointPages } from './checkpoint-package-pages.ts';
import { communicationState } from './communication-state.ts';
import { cachedLocalEvents } from './local-room.ts';
import { ownHolds } from './mail-attention.ts';
import { missing, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { readChunk, readMailIndex, statePath } from './mail-read.ts';
import { checkpointRoomEvents } from './room-catch-up.ts';
import { localCursorPath, roomCursor } from './room-cursor.ts';
import { roomImagePath } from './room-image.ts';
import { answerRecipient } from './room-question.ts';
import { addressedTo } from './room-wake.ts';
import { storageRoot } from './store.ts';
import { readTeamStartup } from './team-startup.ts';
import { telegramConfig } from './telegram-api.ts';
import { roomCursorPath } from './telegram-live.ts';
import { refreshTelegramForLocal } from './telegram-local-refresh.ts';
import { roomEvents } from './telegram-room.ts';

export function telegramIdentity(config: TelegramConfig): string {
	return checkpointHash([config.botToken.split(':')[0], config.chatId]);
}

export async function checkpointConfig(readOnly = false): Promise<TelegramConfig | undefined> {
	if (!readOnly)
		return (await optionalText(join(storageRoot(), 'integrations', 'telegram.json')))
			? telegramConfig()
			: undefined;
	// Do not read config bytes before the secure handle check or repair permissions in this view.
	const exists = await lstat(join(storageRoot(), 'integrations', 'telegram.json')).catch(
		(error: unknown) => {
			if (missing(error)) return undefined;
			throw error;
		},
	);
	return exists ? telegramConfig(readOnly) : undefined;
}

/** Capture each source once; arrivals after its boundary belong to the next package. */
export async function captureCheckpoint(
	name: string,
	state: CheckpointState,
	onTelegramUnavailable: (reason: string) => void = () => {},
): Promise<CheckpointPackage> {
	ownMailbox(name);
	const config = await checkpointConfig();
	let telegramRefreshError: string | undefined;
	if (config)
		await refreshTelegramForLocal(config, false, (reason) => {
			telegramRefreshError = reason;
			onTelegramUnavailable(reason);
		});
	const history = await cachedLocalEvents();
	const from = roomCursor((await optionalText(localCursorPath(name))) ?? '0');
	const sources: CheckpointPackage['sources'] = {
		room: { from, through: history.at(-1)?.id ?? 0 },
		holds: {},
	};
	const inputs: CheckpointInput[] = [];
	for (const event of checkpointRoomEvents(history, from, name)) {
		const parent = event.replyTo === null ? undefined : history[event.replyTo - 1];
		inputs.push({
			source: 'room',
			id: String(event.id),
			forMe:
				event.sender.kind !== 'agent' ||
				addressedTo(event, name) ||
				(parent?.sender.kind === 'agent' && parent.sender.id === name) ||
				answerRecipient(event, history) === name,
			presentation: event.digest
				? 'excerpt'
				: event.ownBodyOmitted
					? 'own-body-omitted'
					: 'exact',
			value: { ...event, ...(event.image ? { imagePath: roomImagePath(event.image) } : {}) },
		});
	}
	if (config) {
		const events = await roomEvents(config);
		const after = roomCursor((await optionalText(roomCursorPath(config, name))) ?? '0');
		const through = events.at(-1)?.sequence ?? 0;
		if (after > through) throw new Error('Telegram cursor exceeds frozen history.');
		sources.telegram = { from: after, through, key: telegramIdentity(config) };
		for (const event of events.filter((item) => item.sequence > after)) {
			const own = event.sender.kind === 'agent' && event.sender.id === name;
			const parent = events.find((item) => item.messageId === event.replyTo);
			inputs.push({
				source: 'telegram',
				id: String(event.sequence),
				forMe:
					event.sender.kind === 'user' ||
					addressedTo(event, name) ||
					(parent?.sender.kind === 'agent' && parent.sender.id === name),
				presentation: own ? 'own-body-omitted' : 'exact',
				// groups is part of the delivered item, so its receipt hash covers who was addressed.
				value: {
					sequence: event.sequence,
					messageId: event.messageId,
					sender: event.sender,
					text: own ? '' : event.text,
					replyTo: event.replyTo,
					...(event.groups ? { groups: event.groups } : {}),
				},
			});
		}
	}
	const { mails, errors } = await readMailIndex(name);
	for (const mail of mails.sort(
		(a, b) => b.sent.localeCompare(a.sent) || b.id.localeCompare(a.id),
	)) {
		if (await optionalText(statePath(name, mail.id, 'read'))) continue;
		let text = '';
		for (let offset = 0; offset < mail.size;) {
			const chunk = await readChunk(name, mail.id, offset);
			if (chunk.size !== mail.size || chunk.end <= offset)
				throw new Error(
					'Mail changed during checkpoint capture. Nothing was acknowledged.',
				);
			text += chunk.text;
			offset = chunk.end;
		}
		inputs.push({
			source: 'mail',
			id: mail.id,
			forMe:
				!['receipt', 'rest-ready'].includes(mail.kind) && mail.noticeStatus !== 'obsolete',
			presentation: 'exact',
			value: { header: mail, text },
		});
	}
	for (const error of errors)
		inputs.push({
			source: 'mail-error',
			id: error.id,
			forMe: true,
			presentation: 'exact',
			value: error,
		});
	for (const hold of await ownHolds(name)) {
		const fingerprint = checkpointHash(hold);
		if (state.seenHolds[hold.id] === fingerprint) continue;
		sources.holds[hold.id] = fingerprint;
		inputs.push({
			source: 'hold',
			id: hold.id,
			forMe: true,
			presentation: 'exact',
			value: hold,
		});
	}
	const { items, pages } = checkpointPages(inputs, {
		roomThrough: from,
		telegramThrough: sources.telegram?.from ?? 0,
		startedAt: await readTeamStartup(),
		paused: (await communicationState()).paused,
		sources,
		...(config ? { config } : {}),
		...(telegramRefreshError ? { telegramRefreshError } : {}),
	});
	return {
		version: 1,
		owner: name,
		id: randomUUID(),
		createdAt: new Date().toISOString(),
		items,
		pages,
		finalReceipt: randomUUID(),
		sources,
	};
}
