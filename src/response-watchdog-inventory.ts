import { join } from 'node:path';

import type { WakeTarget } from './wake-part.ts';

import { checkpointHash } from './checkpoint-package-model.ts';
import { cachedLocalEvents } from './local-room.ts';
import { ownHolds } from './mail-attention.ts';
import { optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { responseMailInventory } from './response-watchdog-mail.ts';
import { localCursorPath, roomCursor } from './room-cursor.ts';
import { receivesRoutineRoom } from './room-wake-policy.ts';
import { roomWakeImmediate } from './room-wake.ts';
import { storageRoot } from './store.ts';
import { telegramConfig } from './telegram-api.ts';
import { roomCursorPath } from './telegram-live.ts';
import { roomEvents } from './telegram-room.ts';
import { wakeTargetRead } from './wake-read-proof.ts';

/** Independent inventory: no notice marks, source cursor writes, network calls or input. */
export async function responseInventory(name: string, nonce: string) {
	ownMailbox(name);
	const targets: WakeTarget[] = [];
	const failures: string[] = [];
	const routine = await receivesRoutineRoom(name).catch(() => {
		failures.push('room-policy');
		return false;
	});
	const collect = async (source: string, read: () => Promise<WakeTarget[]>) => {
		try {
			for (const target of await read())
				if (
					['mail', 'room', 'telegram'].includes(source) ||
					!(await wakeTargetRead(name, nonce, target))
				)
					targets.push(target);
		} catch {
			failures.push(source);
		}
	};
	await collect('readiness', () =>
		Promise.resolve([{ source: 'readiness', key: nonce, through: 0, ids: [] }]),
	);
	await collect('mail', async () => {
		const inventory = await responseMailInventory(name);
		if (inventory.failed) failures.push('mail');
		return inventory.targets;
	});
	await collect('holds', async () =>
		(await ownHolds(name))
			.filter((hold) => hold.decision !== 'pending')
			.map((hold) => ({
				source: 'holds',
				key: 'decisions',
				through: 0,
				ids: [`hold:${hold.id}:${checkpointHash(hold)}`],
			})),
	);
	await collect('room', async () => {
		const events = await cachedLocalEvents();
		const read = roomCursor((await optionalText(localCursorPath(name))) ?? '0');
		const own = new Set(
			events
				.filter((event) => event.sender.kind === 'agent' && event.sender.id === name)
				.map((event) => event.id),
		);
		const unread = events.filter(
			(event) =>
				event.id > read &&
				event.source === 'local' &&
				!(event.sender.kind === 'agent' && event.sender.id === name),
		);
		if (!unread.length || (!routine && !roomWakeImmediate(name, unread, own))) return [];
		// Each eligible bound keeps its own age when newer traffic arrives.
		return unread
			.filter((event) => routine || roomWakeImmediate(name, [event], own))
			.map((event) => ({ source: 'room', key: 'local', through: event.id, ids: [] }));
	});
	await collect('telegram', async () => {
		if (!(await optionalText(join(storageRoot(), 'integrations', 'telegram.json')))) return [];
		const config = await telegramConfig();
		const read = roomCursor((await optionalText(roomCursorPath(config, name))) ?? '0');
		const key = checkpointHash([config.botToken.split(':')[0], config.chatId]);
		const events = await roomEvents(config);
		const own = new Set(
			events
				.filter((event) => event.sender.kind === 'agent' && event.sender.id === name)
				.map((event) => event.messageId),
		);
		return events
			.filter(
				(event) =>
					event.sequence > read &&
					!(event.sender.kind === 'agent' && event.sender.id === name) &&
					(routine || roomWakeImmediate(name, [event], own)),
			)
			.map((event) => ({ source: 'telegram', key, through: event.sequence, ids: [] }));
	});
	if (targets.length > 10000) throw new Error('Response inventory exceeds its storage bound.');
	return { targets, failures: [...new Set(failures)] };
}
