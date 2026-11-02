import type { LocalEvent } from '../local-room.ts';

const THUMBS_UP = '👍';

/**
 * A human thumbs-up is an ordinary room event whose entire body is the emoji and which replies to
 * the message it approves. Nothing about that changes here - it stays persisted, keeps its id and
 * its replyTo, and reaches agents through checkpoint and read exactly as before. An approval is a
 * record before it is a decoration: the team rule that a thumbs-up means "yes, do that" is only
 * usable because an agent can see WHICH message it answered.
 *
 * What changes is where it is drawn. A column of bare 👍 posts is noise in a transcript somebody
 * has to scroll, and it separates the approval from the thing approved by however many messages
 * arrived in between.
 */
export function isHumanReaction(event: LocalEvent): boolean {
	return (
		event.sender.kind === 'user' && event.replyTo !== null && event.text.trim() === THUMBS_UP
	);
}

/**
 * Draw the reaction on the message it answers, and report whether that worked.
 *
 * THE BUTTON CARRIES THE STATE, which is what was actually asked for: "just change the icon when
 * clicked". The first version put a glyph in the meta line instead - present, correct, and 16px of
 * it at the top of the message, a whole message away from the button that was clicked. It was
 * reported as no visual indication at all (#4529), which is the right verdict: feedback that does
 * not appear where the action happened is not feedback.
 *
 * So every reaction now leaves the same id-carrying anchor and draws nothing itself, and the
 * message records that it has been approved. The stylesheet lights the thumbs-up button from that,
 * so the icon under the cursor is the thing that changes.
 *
 * FALSE MEANS THE CALLER MUST STILL RENDER THE POST. The target is missing whenever it fell out of
 * the retained window, and an approval that silently disappears because its subject scrolled away
 * is far worse than one drawn in the wrong place - the operator would believe they had approved
 * something that no longer shows any sign of it.
 */
export function attachReaction(event: LocalEvent): boolean {
	const target = document.getElementById(`room-message-${String(event.replyTo)}`);
	const meta = target?.querySelector('small');
	if (!target || !meta) return false;
	/*
	 * Findable by its id so a #<id> reference still resolves and the scroll still lands, drawn as
	 * nothing because the button is already showing the state. A second thumbs-up on one message
	 * therefore adds a second anchor and no second mark: the icon is a state, not a tally.
	 */
	const mark = document.createElement('span');
	mark.id = `room-message-${String(event.id)}`;
	mark.className = 'room-reaction-anchor';
	mark.setAttribute('aria-label', `Approved by you, #${String(event.id)}`);
	meta.append(mark);
	target.dataset.reacted = 'true';
	const thumb = target.querySelector('.room-message-thumb');
	if (thumb) {
		thumb.setAttribute('aria-pressed', 'true');
		thumb.setAttribute('title', `Approved by you · #${String(event.id)}`);
	}
	return true;
}
