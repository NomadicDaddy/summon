import { expect, test } from 'bun:test';

import {
	ROOM_WAKE_MAX_HOLD_MS,
	ROOM_WAKE_QUIET_MS,
	type RoomWakeBatch,
	roomWakeDue,
	roomWakeImmediate,
	trackRoomWakeBatch,
} from '../src/room-wake.ts';

// Stated here rather than read from the environment, so these cases assert the debounce itself and
// not whatever window the suite happens to run with. The suite runs with it collapsed to zero.
const WINDOWS = { quiet: 5_000, maxHold: 30_000 };

test('under the real defaults a burst is released by quiet, not by the ceiling', () => {
	// The ceiling must stay clear of the quiet window. Equal values make the ceiling the ordinary
	// delivery path and fire mid-burst, which is the behaviour the debounce replaced.
	expect(ROOM_WAKE_MAX_HOLD_MS).toBeGreaterThan(ROOM_WAKE_QUIET_MS);

	const windows = { quiet: ROOM_WAKE_QUIET_MS, maxHold: ROOM_WAKE_MAX_HOLD_MS };
	const batches = new Map<string, RoomWakeBatch>();
	const batch = trackRoomWakeBatch(batches, 'alpha', 1, 0);
	expect(roomWakeDue(batch, 5_000, windows)).toBe(false);

	// A second post just short of the window restarts it, so the burst is still held at the point
	// the old equal-valued ceiling would have released it mid-burst.
	const second = ROOM_WAKE_QUIET_MS - 2_000;
	trackRoomWakeBatch(batches, 'alpha', 2, second);
	expect(roomWakeDue(batch, ROOM_WAKE_QUIET_MS, windows)).toBe(false);

	// It releases one quiet window after the LAST post rather than the first.
	expect(roomWakeDue(batch, second + ROOM_WAKE_QUIET_MS - 1, windows)).toBe(false);
	expect(roomWakeDue(batch, second + ROOM_WAKE_QUIET_MS, windows)).toBe(true);
});

test('a burst is delivered once it falls quiet, and the window restarts on every new message', () => {
	const batches = new Map<string, RoomWakeBatch>();
	const batch = trackRoomWakeBatch(batches, 'alpha', 10, 0);
	expect(roomWakeDue(batch, 4_999, WINDOWS)).toBe(false);
	// Message 11 lands with a second to go, so the wait starts again from there rather than
	// firing on the original message's schedule and leaving 11 for a second notice.
	expect(trackRoomWakeBatch(batches, 'alpha', 11, 4_000)).toBe(batch);
	expect(roomWakeDue(batch, 5_000, WINDOWS)).toBe(false);
	expect(roomWakeDue(batch, 8_999, WINDOWS)).toBe(false);
	expect(roomWakeDue(batch, 9_000, WINDOWS)).toBe(true);
	// A tick that sees no new message must not extend the wait.
	expect(trackRoomWakeBatch(batches, 'alpha', 11, 8_000).lastChangeAt).toBe(4_000);
});

test('a room that never falls quiet still gets its wake at the ceiling', () => {
	const batches = new Map<string, RoomWakeBatch>();
	trackRoomWakeBatch(batches, 'alpha', 0, 0);
	for (let at = 1_000; at <= 29_000; at += 1_000)
		expect(roomWakeDue(trackRoomWakeBatch(batches, 'alpha', at, at), at, WINDOWS)).toBe(false);
	// Still mid-burst - the quiet window has been restarted every second - so only the ceiling can
	// release it. Without one, a continuously busy room would never notify at all.
	expect(roomWakeDue(trackRoomWakeBatch(batches, 'alpha', 30_000, 30_000), 30_000, WINDOWS)).toBe(
		true,
	);
});

test('only human, addressed and replied-to traffic refreshes a wake already sent', () => {
	const peer = { sender: { kind: 'agent', id: 'beta' }, text: 'routine', replyTo: null };
	expect(roomWakeImmediate('alpha', [peer], new Set())).toBe(false);
	for (const text of ['@alpha hello', '@ALPHA hello', '@all hello'])
		expect(roomWakeImmediate('alpha', [{ ...peer, text }], new Set())).toBe(true);
	for (const text of ['mail@alpha', '@alphabet', '@alpha_suffix'])
		expect(roomWakeImmediate('alpha', [{ ...peer, text }], new Set())).toBe(false);
	for (const name of ['dev.ops', 'qa_bot', 'a-b']) {
		expect(roomWakeImmediate(name, [{ ...peer, text: `@${name} look` }], new Set())).toBe(true);
		expect(roomWakeImmediate(name, [{ ...peer, text: `mail@${name}` }], new Set())).toBe(false);
		expect(roomWakeImmediate(name, [{ ...peer, text: `@${name}_other` }], new Set())).toBe(
			false,
		);
	}
	expect(roomWakeImmediate('alpha', [{ ...peer, replyTo: 9 }], new Set([9]))).toBe(true);
	expect(roomWakeImmediate('alpha', [{ ...peer, replyTo: 9 }], new Set([8]))).toBe(false);
	expect(
		roomWakeImmediate(
			'alpha',
			[{ ...peer, sender: { kind: 'user', id: 'operator' } }],
			new Set(),
		),
	).toBe(true);
});
