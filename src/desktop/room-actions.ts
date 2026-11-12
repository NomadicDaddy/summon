import type { LocalEvent } from '../local-room.ts';

import { faultText, reportFault } from './fault-report.ts';
import { readableError } from './ipc-error.ts';

/** Agent actions keep their send state beside the message that owns them. */
export function appendRoomActions(
	item: HTMLElement,
	event: LocalEvent,
	error: HTMLElement,
	refresh: () => Promise<void>,
): void {
	if (event.sender.kind !== 'agent' || event.question) return;
	for (const [label, title, message] of [
		['👍', 'Thumbs up this message', '👍'],
		[
			'?',
			'Ask for a different explanation',
			`@${event.sender.id} Please explain your message #${event.id} again in a different way. Use simpler language and a concrete example; do not just repeat the original wording.`,
		],
	] as const) {
		const action = document.createElement('button');
		action.textContent = label;
		action.title = title;
		action.setAttribute('aria-label', `${title} from ${event.sender.id}, #${event.id}`);
		// The thumbs-up carries the approved state, so it needs a name the stylesheet can find.
		action.className =
			message === '👍' ? 'room-message-action room-message-thumb' : 'room-message-action';
		if (message === '👍') action.setAttribute('aria-pressed', 'false');
		action.addEventListener('click', () => {
			if (action.disabled || action.getAttribute('aria-pressed') === 'true') return;
			action.disabled = true;
			error.hidden = true;
			void window.team
				.roomSend(message, event.id)
				.then(refresh)
				.catch((cause: unknown) => {
					error.textContent = `Action not confirmed. Check the room before retrying. ${readableError(cause)}`;
					error.hidden = false;
					reportFault({ level: 'error', source: 'room.action', text: faultText(cause) });
				})
				.finally(() => {
					action.disabled = false;
				});
		});
		item.append(action);
	}
}
