import type { LocalEvent } from '../local-room.ts';
import type { TeamSnapshot } from './types.ts';

import { setupCommunicationHalt } from './communication-halt.ts';
import { setupComposerHistory } from './composer-history.ts';
import { faultText, reportFault } from './fault-report.ts';
import { readableError } from './ipc-error.ts';
import { setupMacroBar } from './macro-bar.ts';
import { appendRoomActions } from './room-actions.ts';
import { appendRoomImage, roomAttachments } from './room-attachments.ts';
import { copyButton } from './room-copy.ts';
import { highlightRoomMessage } from './room-highlight.ts';
import { setupRoomHistory } from './room-history-place.ts';
import { renderRoomLinks } from './room-links.ts';
import { roomNames } from './room-names.ts';
import { renderRoomQuestion } from './room-questions.ts';
import { attachReaction, isHumanReaction } from './room-reactions.ts';
import { setupRoomReadPlace } from './room-read-place.ts';
import { linkReferences, setupRoomReferences } from './room-references.ts';

export function setupRoom(): (snapshot: TeamSnapshot) => void {
	let names = roomNames([]);
	let rosterKey = '';
	// The roster as last seen, read at copy time so a Shift+click reports the teammate's model as
	// the window currently knows it (model metadata changes without the roster key changing).
	let agents: TeamSnapshot['agents'] = [];
	const get = (id: string): HTMLElement => {
		const node = document.getElementById(id);
		if (!node) throw new Error(`Missing room element ${id}`);
		return node;
	};
	const room = get('room');
	const showHalt = setupCommunicationHalt();
	const messages = get('room-messages');
	// Whether the reader is following the conversation. Only scrolling changes it: content growing
	// under a pinned log does not, so an image that sizes itself late can still re-pin, and one that
	// arrives while the reader is up among older messages leaves them there.
	let following = true;
	messages.addEventListener('scroll', () => {
		following = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
	});
	const keepFollowing = (): void => {
		if (following) messages.scrollTop = messages.scrollHeight;
	};
	const badge = get('room-unread');
	const error = get('room-error');
	const place = setupRoomReadPlace(messages, badge, (message) => {
		error.textContent = message;
		error.hidden = false;
	});
	const input = get('room-text') as HTMLTextAreaElement;
	const renderText = (node: HTMLElement, text: string): void => {
		renderRoomLinks(node, text, names.text, (url) => {
			void window.team.openRoomUrl(url).catch((cause: unknown) => {
				error.textContent = readableError(cause);
				reportFault({ level: 'error', source: 'room.link', text: faultText(cause) });
			});
		});
		linkReferences(node);
	};
	setupRoomReferences(messages, renderText);
	const remember = setupComposerHistory(input);
	input.title =
		'Up on the first line recalls sent messages; Down on the last line restores your draft. Last 50 entries.';
	const attachments = roomAttachments(input, error);
	setupMacroBar(get('room-quick-replies'), (text, send) => {
		input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.focus();
		if (send) (get('room-form') as HTMLFormElement).requestSubmit();
	});
	const button = get('room-send') as HTMLButtonElement;
	input.addEventListener('keydown', (event) => {
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
		event.preventDefault();
		if (!event.repeat && !button.disabled)
			(get('room-form') as HTMLFormElement).requestSubmit();
	});
	let cursor = 0;
	let initialized = false;
	let pending = false;
	let replyTo: number | null = null;
	const selectReply = (id: number | null): void => {
		replyTo = id;
		get('room-reply').hidden = id === null;
		document.querySelector('.room-reply-target')?.classList.remove('room-reply-target');
		const target = id === null ? null : document.getElementById(`room-message-${id}`);
		target?.classList.add('room-reply-target');
		const label = get('room-reply').querySelector('span');
		if (!label) return;
		const author = target?.querySelector('strong')?.textContent ?? '';
		const excerpt = (target?.querySelector('p')?.textContent ?? '').replace(/\s+/g, ' ').trim();
		label.textContent =
			author === ''
				? `Replying to #${id}`
				: `Replying to ${author} #${id}: ${excerpt.slice(0, 60)}${excerpt.length > 60 ? '…' : ''}`;
	};
	const show = (open: boolean): void => {
		if (!open && !room.hidden) place.captureLeave();
		room.hidden = !open;
		document.body.classList.toggle('room-open', open);
		get('room-toggle').setAttribute('aria-expanded', String(open));
		if (open) {
			// The panel is hidden until this runs, and a hidden element has no scroll box, so every
			// scroll-to-bottom that refresh performed while messages were arriving was a no-op that
			// left scrollTop at zero. Without this the room opens on the oldest retained message and
			// the operator scrolls past the rest to reach the conversation they came to read.
			// Reading scrollHeight after unhiding forces the layout the assignment needs.
			if (!history.isBrowsing() && !place.returnToLeftOff())
				messages.scrollTop = messages.scrollHeight;
			input.focus();
		} else get('room-toggle').focus();
	};
	get('room-toggle').addEventListener('click', () => show(room.hidden === true));
	get('room-close').addEventListener('click', () => show(false));
	window.addEventListener('blur', () => {
		if (!room.hidden) place.captureLeave();
	});
	get('room-cancel-reply').addEventListener('click', () => selectReply(null));
	const append = (event: LocalEvent, before?: Element | null): void => {
		if (document.getElementById(`room-message-${event.id}`)) return;
		// Drawn on the message it approves rather than as a post of its own. Falls through to an
		// ordinary post when that message is not on screen, because an approval must never vanish.
		if (isHumanReaction(event) && attachReaction(event)) return;
		const item = document.createElement('article');
		item.className = `room-message ${event.sender.kind}`;
		item.id = `room-message-${event.id}`;
		item.dataset.roomId = String(event.id);
		const sender = document.createElement('strong');
		sender.textContent = event.sender.kind === 'user' ? 'You' : event.sender.id;
		names.sender(sender, event.sender.id, event.sender.kind === 'user');
		const when = document.createElement('small');
		when.textContent = `${new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · #${event.id}${event.source === 'local' ? '' : ' · Telegram'}`;
		const text = document.createElement('p');
		renderText(text, highlightRoomMessage(item, event));
		item.append(sender, when);
		if (event.replyTo !== null) {
			const context = document.createElement('small');
			context.textContent = `Reply to #${event.replyTo}`;
			linkReferences(context);
			item.append(context);
		}
		const reply = document.createElement('button');
		reply.className = 'room-message-reply';
		reply.textContent = 'Reply';
		reply.addEventListener('click', () => {
			selectReply(event.id);
			input.focus();
		});
		// Every message can be copied, including your own and the CLI's; the approval and
		// re-explain actions below stay agent-only because they address the teammate.
		const copy = copyButton(
			event,
			(slug) => agents.find((agent) => agent.slug === slug),
			(copied) => window.team.operatorCopy(copied),
			(cause: unknown) => {
				error.textContent = `Not copied. ${readableError(cause)}`;
				error.hidden = false;
				reportFault({ level: 'error', source: 'room.copy', text: faultText(cause) });
			},
		);
		item.append(text, reply, copy);
		const mark = document.createElement('button');
		mark.type = 'button';
		mark.className = 'room-mark-read';
		mark.textContent = 'Mark read through here';
		mark.setAttribute('aria-label', `Mark Room read through message #${event.id}`);
		mark.addEventListener('click', () => {
			void place.mark(event.id);
		});
		item.append(mark);
		appendRoomActions(item, event, error, refresh);
		if (event.image) appendRoomImage(item, event.image, keepFollowing);
		renderRoomQuestion(item, event);
		if (before) messages.insertBefore(item, before);
		else messages.append(item);
		while (messages.childElementCount > 300) {
			if (before) messages.lastElementChild?.remove();
			else messages.firstElementChild?.remove();
		}
	};
	const history = setupRoomHistory(
		messages,
		get,
		append,
		place.redraw,
		() => cursor,
		() => pending,
		() => {
			initialized = false;
			void refresh();
		},
		(message) => {
			error.textContent = message;
			error.hidden = false;
		},
	);
	const refresh = async (): Promise<void> => {
		if (pending) return;
		pending = true;
		const arrived: LocalEvent[] = [];
		const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
		try {
			if (!initialized) {
				cursor = await window.team.roomTail();
				initialized = true;
			}
			let more = true;
			while (more) {
				const page = await window.team.roomRead(cursor);
				for (const event of page.events) {
					if (!history.isBrowsing()) append(event);
					arrived.push(event);
				}
				cursor = page.nextCursor;
				more = page.more;
				const state = page.paused
					? 'Halted. Agents can read; sending resumes when you say proceed.'
					: 'Everyone shares this conversation.';
				if (get('room-state').textContent !== state) get('room-state').textContent = state;
				showHalt(page.communication);
			}
			if (arrived.length > 0) void place.refresh();
			if (arrived.length > 0 && !history.isBrowsing()) place.redraw();
			if (atBottom && !history.isBrowsing()) messages.scrollTop = messages.scrollHeight;
			history.updateHead();
		} catch (cause: unknown) {
			error.textContent = readableError(cause);
			error.hidden = false;
			reportFault({ level: 'error', source: 'room.read', text: faultText(cause) });
		} finally {
			pending = false;
		}
	};
	get('room-form').addEventListener('submit', (event) => {
		event.preventDefault();
		if (
			button.disabled ||
			attachments.loading() ||
			(!input.value.trim() && !attachments.value())
		)
			return;
		button.disabled = true;
		attachments.lock(true);
		error.hidden = true;
		const sentText = input.value;
		void window.team
			.roomSend(sentText, replyTo, attachments.value())
			.then(async () => {
				remember(sentText);
				input.value = '';
				attachments.clear();
				selectReply(null);
				await refresh();
				messages.scrollTop = messages.scrollHeight;
			})
			.catch((cause: unknown) => {
				error.textContent = `Message not confirmed. Check the room before retrying. ${readableError(cause)}`;
				error.hidden = false;
				reportFault({ level: 'error', source: 'room.send', text: faultText(cause) });
			})
			.finally(() => {
				button.disabled = false;
				attachments.lock(false);
			});
	});
	const timer = setInterval(() => {
		void refresh();
	}, 1000);
	window.addEventListener('beforeunload', () => {
		if (!room.hidden) place.captureLeave();
		clearInterval(timer);
	});
	return (snapshot) => {
		void place.selectTeam(snapshot.team).then(() => {
			if (!initialized) void refresh();
		});
		agents = snapshot.agents;
		const key = JSON.stringify([
			snapshot.agents.map(({ name, slug }) => ({ name, slug })),
			snapshot.operator,
		]);
		if (key === rosterKey) return;
		rosterKey = key;
		names = roomNames(snapshot.agents, snapshot.operator);
		for (const text of messages.querySelectorAll('p')) renderText(text, text.textContent);
	};
}
