import { expect, test } from 'bun:test';

import { type BoardUiCase, measureBoardUi } from './fixtures/board-ui-harness.ts';

const sizes = [
	[2250, 1309],
	[2560, 1440],
	[1920, 1200],
	[1440, 900],
] as const;
const cases: BoardUiCase[] = sizes.flatMap(([width, height]) => [
	{ height, room: false, width },
	{ height, room: true, width },
]);

/**
 * Team-board clauses 36, 38 and 43 on the real Board at the four desktop sizes, Room closed and
 * open. Twenty comments put an author, a time and a revision at every wrapping offset the lane
 * gives, and every prefix of a long title is tried under the caret, plain and search-marked. Before
 * the change, metadata broke inside "revision 1" and the times, the caret wrapped onto a line of
 * its own, and the comment count stayed on the card above the comments it counted. Six lanes are
 * populated; a card with nothing to disclose and the open card's own actions are the controls.
 */
test('Board card faces keep metadata tokens, the caret and the comment count in place', async () => {
	const measured = await measureBoardUi('board-card-face-renderer', 'BOARD_FACE', cases);
	expect(measured).toEqual(
		cases.map(({ height, room, width }) => ({
			actionsReachable: true,
			boardOverflowX: false,
			caret: { alone: 0, aloneMarked: 0, tried: 24 },
			count: { closed: true, closedAgain: true, open: false },
			detailsShown: true,
			// A keyboard-focused action draws its ring inside the 2px gap instead of over its neighbour.
			// Whether the hidden window holds page focus is recorded, not asserted.
			focusRing: {
				clear: true,
				gap: 2,
				pageFocused: expect.any(Boolean) as boolean,
				reach: 0,
				style: 'solid',
			},
			// The shared fixture gives the renderer exactly the requested viewport or fails the case.
			height,
			keyboardOpened: true,
			laneWidth: expect.any(Number) as number,
			laneWidthsStable: true,
			pageFits: true,
			plain: { count: false, disclosure: false },
			room,
			// Oversize tokens wrap inside themselves by design; overflow says none ran out of the card.
			tokens: {
				broken: 0,
				checked: 60,
				examples: [],
				overflow: 0,
				oversize: expect.any(Number) as number,
			},
			width,
		})),
	);
}, 90000);
