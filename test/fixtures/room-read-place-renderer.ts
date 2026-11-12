import type { TeamSnapshot } from '../../src/desktop/types.ts';

import { setupRoom } from '../../src/desktop/room.ts';

const events = Array.from({ length: 450 }, (_, index) => ({
	id: index + 1,
	at: '2026-11-12T00:00:00.000Z',
	sender: { kind: 'agent' as const, id: 'fixture' },
	text: `Fixture post ${index + 1}`,
	replyTo: null,
	source: 'local',
}));

if (localStorage.getItem('room-read-place:default') === null)
	localStorage.setItem(
		'room-read-place:default',
		JSON.stringify({ readThrough: 100, leftAt: 120 }),
	);
const bridge = {
	roomTail: () => Promise.resolve(150),
	roomRead: (after: number) => {
		const page = events.filter((event) => event.id > after).slice(0, 20);
		return Promise.resolve({
			events: page,
			nextCursor: page.at(-1)?.id ?? after,
			more: after + page.length < events.length,
			paused: false,
			communication: { paused: false, changedAt: 0, attribution: null },
		});
	},
	roomBefore: (before: number) => {
		const prior = events.filter((event) => event.id < before);
		const page = prior.slice(-20);
		return Promise.resolve({
			events: page,
			nextBefore: page[0]?.id ?? before,
			more: prior.length > page.length,
		});
	},
	roomUnread: (after: number) =>
		Promise.resolve({
			firstUnread: after < 450 ? after + 1 : null,
			unread: Math.max(0, 450 - after),
			known: after <= 450,
		}),
	roomSend: () => Promise.resolve(events[0]),
	onImagePaste: () => undefined,
	macros: () => Promise.resolve([]),
};
Object.assign(window, { team: bridge });
const update = setupRoom();
update({ agents: [], operator: null, team: undefined } as unknown as TeamSnapshot);
document.title = 'ROOM_PLACE_READY';
