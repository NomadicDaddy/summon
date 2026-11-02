import { expect, test } from 'bun:test';

import { measureBoardUi } from './fixtures/board-ui-harness.ts';

/**
 * Team-board clause 45: six lanes at 1440x900 with the Room open and closed. The lanes wrap there,
 * and a 2026-10-18 design sweep found the wrapped rows splitting the Board's height evenly, so the
 * first row was about 157px and every card was cut off through its actions. Real index.html, every
 * stylesheet it links and the real Board code, at 1440x900. Each lane's first card must show its
 * actions without the lane being scrolled; the Board scrolls instead, and the window never does.
 */
test('wrapped Board lanes at 1440x900 show each first card through its actions', async () => {
	const measured = await measureBoardUi('board-lanes-renderer', 'BOARD_LANES', [
		{ height: 900, room: false, width: 1440 },
		{ height: 900, room: true, width: 1440 },
	]);
	// Wrapping is the condition under test, so both cases must actually wrap (five lanes and one with
	// the Room closed, two a row with it open), at the size the clause names. Before the row floor
	// every first card here was cut off, by 14-60px closed and 53-73px open.
	const common = { boardScrolls: true, clipped: [], height: 900, pageFits: true, width: 1440 };
	expect(measured).toEqual([
		{
			...common,
			boardWidth: 1183,
			firstRow: 5,
			room: false,
			rows: 2,
			tightest: expect.any(Number) as number,
		},
		{
			...common,
			boardWidth: 631,
			firstRow: 2,
			room: true,
			rows: 3,
			tightest: expect.any(Number) as number,
		},
	]);
	// Clear by more than a line of title, so the next longer title does not cut it again.
	for (const { tightest } of measured) expect(tightest).toBeGreaterThanOrEqual(24);
}, 30000);
