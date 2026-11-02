import type { LocalEvent } from '../local-room.ts';

/** Replace the transport's attention heading with a visual treatment in the Team Room. */
export function highlightRoomMessage(item: HTMLElement, event: LocalEvent): string {
	const heading = /^📣 FOR YOU\r?\n\r?\n/;
	if (event.sender.kind !== 'agent' || !heading.test(event.text)) return event.text;
	if (!event.question) {
		item.classList.add('room-for-user');
		item.setAttribute('aria-label', `Message for you from ${event.sender.id}`);
	}
	return event.text.replace(heading, '');
}
