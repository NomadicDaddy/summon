import type { CommunicationStatus } from '../../src/communication-state.ts';
import type { LocalEvent } from '../../src/local-room.ts';

import { setupCommunicationHalt } from '../../src/desktop/communication-halt.ts';
import { card, showBoard } from './board-fixture.ts';

/*
 * The halt banner over the real Board, with the Room closed or open (`?room`). Only roomSend is
 * stubbed: Proceed must reach it as the operator's own "proceed" post and nothing else.
 */
const sent: [string, number | null][] = [];
const team = {
	roomSend: (text: string, replyTo: number | null) => {
		sent.push([text, replyTo]);
		return Promise.resolve({} as LocalEvent);
	},
};
Object.defineProperty(window, 'team', { value: team });
showBoard([card('doing', 'Show who halted the team', 'jimmy')]);
const show = setupCommunicationHalt();
const halted: CommunicationStatus = {
	attribution: { actor: { id: 'operator', kind: 'operator' }, channel: 'team-room' },
	changedAt: Date.now() - 60000,
	paused: true,
};
show(halted);

function visible(id: string): boolean {
	const node = document.getElementById(id);
	if (!node) return false;
	const box = node.getBoundingClientRect();
	return getComputedStyle(node).display !== 'none' && box.width > 0 && box.height > 0;
}

async function measure(): Promise<void> {
	const banner = document.getElementById('comms-halt');
	const toolbar = document.querySelector('main .toolbar');
	if (!banner || !toolbar || !visible('board')) {
		requestAnimationFrame(() => void measure());
		return;
	}
	const box = banner.getBoundingClientRect();
	const shown = {
		aboveToolbar: box.bottom <= toolbar.getBoundingClientRect().top,
		inView: box.top >= 0 && box.right <= innerWidth,
		text: document.getElementById('comms-halt-text')?.textContent ?? '',
		visible: visible('comms-halt'),
	};
	document.getElementById('comms-halt-proceed')?.click();
	await Promise.resolve();
	show({ ...halted, attribution: null, paused: false });
	document.title = `COMMS_HALT ${JSON.stringify({
		...shown,
		boardOpen: visible('board'),
		hiddenAfterProceed: !visible('comms-halt'),
		roomOpen: visible('room'),
		sent,
	})}`;
}
requestAnimationFrame(() => void measure());
