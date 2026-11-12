import type { LocalEvent } from './local-room.ts';

/** A human approval is an event but normally decorates its parent rather than taking a row. */
export function isRoomReaction(event: LocalEvent): boolean {
	return event.sender.kind === 'user' && event.replyTo !== null && event.text.trim() === '👍';
}
