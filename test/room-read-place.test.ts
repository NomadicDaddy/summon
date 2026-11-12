import { describe, expect, test } from 'bun:test';

import type { LocalEvent } from '../src/local-room.ts';

import {
	lastFullyVisibleMessage,
	parseRoomPlace,
	roomPlaceKey,
	saveRoomPlace,
} from '../src/desktop/room-read-place.ts';
import { beforePage, unreadStats } from '../src/local-room-read-place.ts';

const event = (id: number, text = `Post ${id}`, replyTo: number | null = null): LocalEvent => ({
	id,
	at: '2026-11-12T00:00:00.000Z',
	sender: { kind: 'user', id: 'operator' },
	text,
	replyTo,
	source: 'local',
});

describe('Room read place storage', () => {
	test('read and leave markers remain separate and teams have separate keys', () => {
		const values = new Map<string, string>();
		const storage = { setItem: (key: string, value: string) => void values.set(key, value) };
		const readPlace = { readThrough: 10, leftAt: 18 };
		saveRoomPlace(storage, undefined, readPlace);
		saveRoomPlace(storage, 'other team', { readThrough: 3, leftAt: null });
		expect(roomPlaceKey(undefined)).not.toBe(roomPlaceKey('other team'));
		expect(parseRoomPlace(values.get(roomPlaceKey(undefined)) ?? null)).toEqual(readPlace);
		expect(parseRoomPlace(values.get(roomPlaceKey('other team')) ?? null)).toEqual({
			readThrough: 3,
			leftAt: null,
		});
		expect(parseRoomPlace(null)).toEqual({ readThrough: null, leftAt: null });
	});

	test('invalid data and failed writes cannot become an implicit read claim', () => {
		for (const raw of [
			'{',
			'null',
			'{}',
			'{"readThrough":-1,"leftAt":null}',
			'{"readThrough":1.5,"leftAt":null}',
			'{"readThrough":null,"leftAt":"5"}',
		])
			expect(() => parseRoomPlace(raw)).toThrow();
		expect(() =>
			saveRoomPlace(
				{
					setItem: () => {
						throw new Error('disk full');
					},
				},
				undefined,
				{ readThrough: 7, leftAt: null },
			),
		).toThrow('disk full');
	});
});

describe('Room history position', () => {
	test('counts posts after the boundary rather than subtracting IDs', () => {
		const events = [event(8), event(9), event(10, '👍', 8), event(11), event(12, '👍 note', 8)];
		expect(unreadStats(events, 8, 12)).toEqual({ firstUnread: 9, unread: 3, known: true });
		expect(unreadStats(events, 12, 12)).toEqual({ firstUnread: null, unread: 0, known: true });
		expect(unreadStats(events, 6, 12).known).toBe(false);
		expect(unreadStats(events, 13, 12).known).toBe(false);
		expect(unreadStats([], 1, 12).known).toBe(false);
	});

	test('pages a long absence in chronological groups of at most twenty', () => {
		const events = Array.from({ length: 420 }, (_, index) => event(index + 1));
		const first = beforePage(events, 201);
		expect(first.events.map((item) => item.id)).toEqual(
			Array.from({ length: 20 }, (_, index) => index + 181),
		);
		expect(first.nextBefore).toBe(181);
		expect(first.more).toBe(true);
		const second = beforePage(events, first.nextBefore);
		expect(second.events[0]?.id).toBe(161);
		expect(second.events.at(-1)?.id).toBe(180);
	});

	test('only a fully visible post can be a leave bookmark', () => {
		const item = (id: number, top: number, bottom: number) => ({
			dataset: { roomId: String(id) },
			getBoundingClientRect: () => ({ top, bottom, height: bottom - top }),
		});
		const messages = {
			getBoundingClientRect: () => ({ top: 10, bottom: 110 }),
			querySelectorAll: () => [item(1, 0, 20), item(2, 20, 70), item(3, 70, 120)],
		} as unknown as HTMLElement;
		expect(lastFullyVisibleMessage(messages)).toBe(2);
	});
});
