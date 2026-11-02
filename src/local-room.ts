import { join } from 'node:path';

import { openLocalHistory } from './local-room-segments.ts';
import { readLocalHistory, rotateCommittedEvents } from './local-room-storage.ts';
import { atomicWrite, locked } from './mail-files.ts';
import {
	assertGroupsMatchText,
	type PresenceResolver,
	resolveRoomGroups,
	type RoomGroups,
	validRoomGroups,
} from './room-groups.ts';
import { roomQueryCache } from './room-query-cache.ts';
import { type RoomAnswer, type RoomQuestion, validQuestionEvent } from './room-question.ts';
import { storageRoot } from './store.ts';

export interface LocalEvent {
	id: number;
	at: string;
	sender: { kind: 'user' | 'agent' | 'cli'; id: string };
	text: string;
	replyTo: number | null;
	source: string;
	image?: string;
	question?: RoomQuestion;
	answer?: RoomAnswer;
	groups?: RoomGroups;
}
export const localRoomPath = (): string => join(storageRoot(), 'room', 'events.json');
// Full-history consumers are not yet converted: retain their existing shared cache rather
// than repeatedly parsing a large history on every receiver/mention tick.
const cachedEvents = roomQueryCache<LocalEvent[]>();
const cachedHead = roomQueryCache<number>();
const cachedPage = roomQueryCache<{ events: LocalEvent[]; nextCursor: number; more: boolean }>();

/** Explicit full-history consumers still share an unbounded result; writers scan under lock. */
export const cachedLocalEvents = (): Promise<LocalEvent[]> =>
	cachedEvents(localRoomPath(), '', async () =>
		validateEvents((await readLocalHistory(localRoomPath(), false)).events),
	);

export async function localTail(count: number): Promise<number> {
	if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid room tail size.');
	return Math.max(0, (await localHead()) - count);
}

export const localHead = (): Promise<number> =>
	cachedHead(localRoomPath(), '', async () => (await scanLocalEvents(() => undefined)).through);

export async function localEvents(): Promise<LocalEvent[]> {
	return validateEvents((await readLocalHistory(localRoomPath())).events);
}

function validEvent(item: unknown, id: number, previous: LocalEvent[]): boolean {
	if (!item || typeof item !== 'object') return false;
	const event = item as Partial<LocalEvent>;
	return (
		event.id === id &&
		typeof event.at === 'string' &&
		typeof event.text === 'string' &&
		typeof event.source === 'string' &&
		(event.image === undefined ||
			(typeof event.image === 'string' && /^[a-f0-9]{64}$/.test(event.image))) &&
		(event.replyTo === null ||
			(Number.isSafeInteger(event.replyTo) &&
				Number(event.replyTo) > 0 &&
				Number(event.replyTo) < event.id)) &&
		(event.sender?.kind === 'user' ||
			event.sender?.kind === 'agent' ||
			event.sender?.kind === 'cli') &&
		typeof event.sender.id === 'string' &&
		validRoomGroups(event.groups) &&
		validQuestionEvent(event, previous)
	);
}

function validateEvents(events: unknown): LocalEvent[] {
	if (
		!Array.isArray(events) ||
		!events.every((item: unknown, index) => validEvent(item, index + 1, events as LocalEvent[]))
	)
		throw new Error('Invalid local room history.');
	return events as LocalEvent[];
}

/** Accumulate bounded query results; callers must await complete validation before any effect. */
export async function scanLocalEvents(consume: (event: LocalEvent) => void) {
	return scanSnapshot(await openLocalHistory(localRoomPath()), consume);
}

async function scanSnapshot(
	snapshot: Awaited<ReturnType<typeof openLocalHistory>>,
	consume: (event: LocalEvent) => void,
) {
	const through = await snapshot.visit(async (item, id) => {
		const event = item as Partial<LocalEvent> | null;
		const question = event?.answer ? await snapshot.find(event.answer.questionId) : undefined;
		if (!validEvent(item, id, question ? [question as LocalEvent] : []))
			throw new Error('Invalid local room history.');
		consume(item as LocalEvent);
	});
	return { through, liveStart: snapshot.liveStart };
}

/** The most UTF-16 code units one room message may hold. */
export const ROOM_TEXT_LIMIT = 4096;

export async function appendLocalEvent(
	input: Omit<LocalEvent, 'id' | 'at'>,
	resolvePresence?: PresenceResolver,
): Promise<LocalEvent> {
	if ((!input.text.trim() && !input.image) || input.text.length > ROOM_TEXT_LIMIT)
		throw new Error('Room messages require 1–4096 characters.');
	if (input.image !== undefined && !/^[a-f0-9]{64}$/.test(input.image))
		throw new Error('Invalid room image.');
	if (!validRoomGroups(input.groups)) throw new Error('Invalid room groups.');
	if (input.groups) assertGroupsMatchText(input.groups, input.text);
	// @online and @offline resolve here, at send time, outside the room lock (a presence read
	// starts a process snapshot). A mirror passes the groups its source already resolved.
	const groups =
		input.groups ?? (await resolveRoomGroups(input.text, input.sender, resolvePresence));
	return locked(`${localRoomPath()}.lock`, async () => {
		const snapshot = await openLocalHistory(localRoomPath(), true);
		const events: LocalEvent[] = [];
		let question: LocalEvent | undefined;
		let answered: LocalEvent | undefined;
		let existing: LocalEvent | undefined;
		let hasReply = input.replyTo === null;
		const { through } = await scanSnapshot(snapshot, (event) => {
			if (event.id >= snapshot.liveStart) events.push(event);
			if (event.id === input.answer?.questionId) question = event;
			if (!answered && input.answer && event.answer?.questionId === input.answer.questionId)
				answered = event;
			if (!existing && input.source !== 'local' && event.source === input.source)
				existing = event;
			if (event.id === input.replyTo) hasReply = true;
		});
		if (!validQuestionEvent(input, question ? [question] : []))
			throw new Error('Invalid room question or answer.');
		if (input.answer) {
			if (answered) {
				if (
					answered.text === input.text.trim() &&
					answered.answer?.choice === input.answer.choice
				)
					return answered;
				throw new Error('This question has already been answered.');
			}
		}
		if (existing) return existing;
		if (!hasReply) throw new Error('Reply target is not in the local room.');
		const event: LocalEvent = {
			...input,
			...(groups ? { groups } : {}),
			text: input.text.trim(),
			id: through + 1,
			at: new Date().toISOString(),
		};
		const live = await rotateCommittedEvents(events, snapshot.liveStart);
		live.push(event);
		await atomicWrite(localRoomPath(), JSON.stringify(live));
		return event;
	});
}

export async function localPage(after: number) {
	if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid room cursor.');
	return cachedPage(localRoomPath(), String(after), () => readPage(after));
}

async function readPage(after: number) {
	const events: LocalEvent[] = [];
	let size = 0;
	let full = false;
	const { through } = await scanLocalEvents((event) => {
		if (event.id <= after || full || events.length >= 20) return;
		const bytes = Buffer.byteLength(JSON.stringify(event));
		if (size + bytes > 28000) {
			full = true;
			return;
		}
		events.push(event);
		size += bytes;
	});
	if (after > through) throw new Error('Cursor exceeds room history.');
	return {
		events,
		nextCursor: events.at(-1)?.id ?? after,
		more: after + events.length < through,
	};
}
