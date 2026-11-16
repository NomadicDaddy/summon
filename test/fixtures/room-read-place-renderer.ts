import type { TeamSnapshot } from '../../src/desktop/types.ts';
import type { LocalEvent } from '../../src/local-room.ts';

import { setupRoom } from '../../src/desktop/room.ts';

const events: LocalEvent[] = Array.from({ length: 450 }, (_, index) => ({
	id: index + 1,
	at: '2026-11-12T00:00:00.000Z',
	sender: { kind: 'agent', id: 'fixture' },
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
	// With `readDelay` set, each read waits that long and `readInFlight` is true meanwhile, so the
	// test can scroll while a refresh is provably in flight.
	roomRead: async (after: number) => {
		const control = window as unknown as { readDelay?: number; readInFlight?: boolean };
		if (control.readDelay) {
			control.readInFlight = true;
			await new Promise((resolve) => setTimeout(resolve, control.readDelay));
			control.readInFlight = false;
		}
		const page = events.filter((event) => event.id > after).slice(0, 20);
		return {
			events: page,
			nextCursor: page.at(-1)?.id ?? after,
			more: after + page.length < events.length,
			paused: false,
			communication: { paused: false, changedAt: 0, attribution: null },
		};
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
	// With `unreadDelay` set, each unread query answers that late, so the test can land a second
	// post while the first one's query is still in flight. The answer reflects the moment it lands.
	roomUnread: async (after: number) => {
		const control = window as unknown as { unreadDelay?: number };
		if (control.unreadDelay)
			await new Promise((resolve) => setTimeout(resolve, control.unreadDelay));
		return {
			firstUnread: after < events.length ? after + 1 : null,
			unread: Math.max(0, events.length - after),
			known: after <= events.length,
		};
	},
	roomSend: () => Promise.resolve(events[0]),
	onImagePaste: () => undefined,
	macros: () => Promise.resolve([]),
};
// Posts one more message, as a teammate would or, with `own`, as the operator sending it from
// another control, so the test can see whether the Room shows it and whether it counts as read.
const post = (own = false): number => {
	const id = events.length + 1;
	events.push({
		id,
		at: '2026-11-12T00:00:00.000Z',
		sender: own ? { kind: 'user', id: 'operator' } : { kind: 'agent', id: 'fixture' },
		text: `Fixture post ${id}`,
		replyTo: null,
		source: 'local',
	});
	return id;
};
Object.assign(window, { team: bridge, roomFixturePost: post });
const update = setupRoom();
// Switches the Window to another team's Room place, as a team change in the Window would.
const selectTeam = (team: string | undefined): void => {
	update({ agents: [], operator: null, team } as unknown as TeamSnapshot);
};
Object.assign(window, { roomFixtureTeam: selectTeam });
selectTeam(undefined);
document.title = 'ROOM_PLACE_READY';
