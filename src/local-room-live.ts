import { join } from 'node:path';

import type { CheckpointPackage } from './checkpoint-package-model.ts';
import type { WakePart } from './wake-part.ts';

import { CHECKPOINT_NOTICE_INSTRUCTION } from './checkpoint-work.ts';
import { cachedLocalEvents } from './local-room.ts';
import { atomicWrite, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { runtimePath } from './mail-session.ts';
import { currentRoomRequest } from './room-current-request.ts';
import { localCursorPath, roomCursor } from './room-cursor.ts';
import { receivesRoutineRoom } from './room-wake-policy.ts';
import {
	type RoomWakeBatch,
	roomWakeCauses,
	roomWakeDue,
	trackRoomWakeBatch,
	wakeCauseText,
} from './room-wake.ts';
import { wakeRoomReadThrough } from './wake-read-boundary.ts';

const batches = new Map<string, RoomWakeBatch>();

interface LocalNotice {
	through: number;
	state: 'attempted' | 'queued' | 'failed' | 'deferred';
}

async function localNotice(path: string): Promise<LocalNotice> {
	const raw = await optionalText(path);
	if (raw === undefined) return { through: 0, state: 'attempted' };
	// The old writer persisted a bare cursor before calling send(), so delivery is uncertain.
	if (/^\d+$/.test(raw)) return { through: roomCursor(raw), state: 'attempted' };
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error('Invalid local room notification state.');
	}
	if (
		!value ||
		typeof value !== 'object' ||
		!('through' in value) ||
		!Number.isSafeInteger(value.through) ||
		Number(value.through) < 0 ||
		!('state' in value) ||
		!['attempted', 'queued', 'failed', 'deferred'].includes(String(value.state))
	)
		throw new Error('Invalid local room notification state.');
	return value as LocalNotice;
}

/**
 * `coalesceQueued` is for a receiver whose provider queues submitted input and cannot withdraw it
 * (Codex, #24276). A notice already submitted there says to checkpoint, which reads everything after
 * it, so no further Room notice is submitted until that one is read or covered.
 */
export async function prepareLocalRoomNotice(
	name: string,
	nonce: string,
	packet?: CheckpointPackage,
	coalesceQueued = false,
): Promise<WakePart | undefined> {
	ownMailbox(name);
	if (!/^[a-z0-9-]+$/i.test(nonce)) throw new Error('Invalid launch nonce.');
	const path = join(runtimePath(name), `${nonce}-room.notice`);
	const read = roomCursor((await optionalText(localCursorPath(name))) ?? '0');
	const previous = await localNotice(path);
	const notified = previous.state === 'deferred' ? 0 : previous.through;
	if (![read, notified].every((value) => Number.isSafeInteger(value) && value >= 0))
		throw new Error('Invalid room notification cursor.');
	const history = await cachedLocalEvents();
	const covered = packet?.sources.room.through ?? 0;
	// Only a confirmed submission holds; an uncertain or deferred one keeps today's behaviour.
	if (
		coalesceQueued &&
		previous.state === 'queued' &&
		Math.max(read, covered) < previous.through
	) {
		batches.delete(path);
		return;
	}
	const unread = history.filter(
		(event) =>
			event.id > Math.max(read, notified, covered) &&
			event.source === 'local' &&
			!(event.sender.kind === 'agent' && event.sender.id === name),
	);
	const through = unread.at(-1)?.id;
	if (through === undefined) {
		batches.delete(path);
		return;
	}
	const ownIds = new Set(
		history
			.filter((event) => event.sender.kind === 'agent' && event.sender.id === name)
			.map((event) => event.id),
	);
	const causes = roomWakeCauses(name, unread, ownIds).map((event) => event.id);
	if (causes.length === 0 && !(await receivesRoutineRoom(name))) return;
	const batch = trackRoomWakeBatch(batches, path, through);
	if (!roomWakeDue(batch)) return;
	batches.delete(path);
	const acknowledged = async (): Promise<boolean> => (await wakeRoomReadThrough(name)) >= through;
	return {
		target: { source: 'room', key: 'local', through, ids: [] },
		text:
			wakeCauseText('room', through, causes) +
			CHECKPOINT_NOTICE_INSTRUCTION +
			(await currentRoomRequest(name)),
		needed: async () => !(await acknowledged()),
		acknowledged,
		mark: async (state) => {
			await atomicWrite(path, JSON.stringify({ through, state }));
		},
	};
}
