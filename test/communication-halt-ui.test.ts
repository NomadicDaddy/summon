import { describe, expect, test } from 'bun:test';

import type { CommunicationStatus } from '../src/communication-state.ts';

import { haltActor, haltText, haltTime } from '../src/desktop/communication-halt.ts';
import { measureBoardUi } from './fixtures/board-ui-harness.ts';

/*
 * operator-attributed-communication-halt (#15563): the Team Window shows an active communications
 * halt from every tab, says who halted and from where exactly as recorded, never guesses when that
 * was not recorded, and offers Proceed as the operator's own Room post.
 */
const zone = 'America/Chicago';
// 2026-10-19 09:45 CDT, and the same wall time a day earlier.
const now = Date.parse('2026-10-19T14:45:00.000Z');
const yesterday = Date.parse('2026-10-18T14:45:00.000Z');
const lastYear = Date.parse('2025-10-19T14:45:00.000Z');
const operator = { id: 'operator', kind: 'operator' } as const;

describe('halt wording', () => {
	test('names each recorded channel and never invents an actor', () => {
		expect(haltActor({ actor: operator, channel: 'cli' })).toBe('by you from the command line');
		expect(haltActor({ actor: operator, channel: 'team-room' })).toBe(
			'by you from the Team Room',
		);
		expect(
			haltActor({ actor: { id: '518034417', kind: 'telegram-user' }, channel: 'telegram' }),
		).toBe('by Telegram user 518034417');
		expect(haltActor(null)).toBeNull();
	});

	test('times are local, with the date only when it was not today', () => {
		expect(haltTime(now - 60000, now, zone)).toBe('09:44');
		expect(haltTime(yesterday, now, zone)).toBe('Oct 18 09:45');
	});

	test('the same month and day in an earlier year is not today, and shows its year', () => {
		expect(haltTime(lastYear, now, zone)).toBe('Oct 19, 2025 09:45');
	});

	test('the sentence carries time, actor and what is stopped; nothing while open', () => {
		const status: CommunicationStatus = {
			attribution: { actor: operator, channel: 'team-room' },
			changedAt: now - 60000,
			paused: true,
		};
		const stopped =
			'Teammates cannot send mail, Room posts or Telegram messages until you proceed.';
		expect(haltText(status, now, zone)).toBe(
			`Communications halted at 09:44 by you from the Team Room. ${stopped}`,
		);
		expect(haltText({ ...status, attribution: null }, now, zone)).toBe(
			`Communications halted at 09:44. Who halted them was not recorded. ${stopped}`,
		);
		expect(haltText({ ...status, paused: false }, now, zone)).toBeNull();
	});
});

describe('halt markup and wiring', () => {
	const html = Bun.file('src/desktop/index.html').text();

	test('the banner is window-level, outside every tab, and separate from Hold Interruptions', async () => {
		const page = await html;
		const main = page.slice(page.indexOf('<main>'), page.indexOf('</main>'));
		const banner = main.indexOf('id="comms-halt"');
		expect(banner).toBeGreaterThan(-1);
		expect(banner).toBeLessThan(main.indexOf('class="toolbar"'));
		expect(banner).toBeLessThan(main.indexOf('<section'));
		expect(page).toMatch(/<span id="comms-halt-text" role="status">/u);
		expect(page).toMatch(/<span id="comms-halt-error" role="alert" hidden>/u);
		expect(page).toMatch(/<button id="comms-halt-proceed" class="primary" type="button">/u);
		expect(page).toContain('<link rel="stylesheet" href="communication-halt.css" />');
		const source = await Bun.file('src/desktop/communication-halt.ts').text();
		expect(source).not.toMatch(/notification-pause|pauseNotifications/u);
	});

	test('room-read hands the renderer the attributed status beside the old boolean', async () => {
		const main = await Bun.file('src/desktop/main.ts').text();
		expect(main).toContain('const communication = await communicationStatus();');
		expect(main).toContain(
			'return { ...(await localPage(after)), communication, paused: communication.paused };',
		);
	});
});

test('the banner shows over the Board with the Room closed and open, and Proceed posts proceed', async () => {
	const cases = [
		{ height: 1309, room: false, width: 2250 },
		{ height: 900, room: false, width: 1440 },
		{ height: 900, room: true, width: 1440 },
	];
	const measured = await measureBoardUi('comms-halt-renderer', 'COMMS_HALT', cases);
	const common = {
		aboveToolbar: true,
		boardOpen: true,
		hiddenAfterProceed: true,
		inView: true,
		sent: [['proceed', null]],
		text: expect.stringMatching(
			/^Communications halted at \d\d:\d\d by you from the Team Room\. /u,
		) as string,
		visible: true,
	};
	expect(measured).toEqual(
		cases.map(({ height, room, width }) => ({
			...common,
			// The shared fixture gives the renderer exactly the requested viewport or fails the case.
			height,
			room,
			roomOpen: room,
			width,
		})),
	);
}, 45000);
