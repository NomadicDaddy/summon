import type { TeamSnapshot } from '../../src/desktop/types.ts';

import { setupRoom } from '../../src/desktop/room.ts';

// A Room with 60 retained posts and a bridge the driver can add posts to, so the driver can scroll
// to a chosen distance from the bottom and see where a new arrival leaves the reader.
const post = (id: number) => ({
	id,
	at: '2026-11-12T00:00:00.000Z',
	sender: { kind: 'agent' as const, id: 'fixture' },
	text: `Fixture post ${id}. ${'A line of text long enough to wrap in the Room. '.repeat(1 + (id % 3))}`,
	replyTo: null,
	source: 'local',
});
const events = Array.from({ length: 60 }, (_, index) => post(index + 1));

localStorage.setItem('room-read-place:default', JSON.stringify({ readThrough: 60, leftAt: 60 }));
const bridge = {
	roomTail: () => Promise.resolve(0),
	roomRead: (after: number) => {
		const page = events.filter((event) => event.id > after).slice(0, 100);
		return Promise.resolve({
			events: page,
			nextCursor: page.at(-1)?.id ?? after,
			more: false,
			paused: false,
			communication: { paused: false, changedAt: 0, attribution: null },
		});
	},
	roomBefore: () => Promise.resolve({ events: [], nextBefore: 1, more: false }),
	roomUnread: () => Promise.resolve({ firstUnread: null, unread: 0, known: true }),
	roomSend: () => Promise.resolve(events[0]),
	onImagePaste: () => undefined,
	macros: () => Promise.resolve([]),
};
Object.assign(window, {
	team: bridge,
	addFixturePost: () => {
		events.push(post(events.length + 1));
		return events.length;
	},
});
const update = setupRoom();
update({ agents: [], operator: null, team: undefined } as unknown as TeamSnapshot);
document.title = 'ROOM_FOLLOW_READY';
