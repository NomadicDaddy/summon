import type { LocalEvent } from '../local-room.ts';
import type { TeamSnapshot } from './types.ts';

import { setupCommunicationHalt } from './communication-halt.ts';
import { setupComposerHistory } from './composer-history.ts';
import { faultText, reportFault } from './fault-report.ts';
import { readableError } from './ipc-error.ts';
import { setupMacroBar } from './macro-bar.ts';
import { appendRoomImage, roomAttachments } from './room-attachments.ts';
import { copyButton } from './room-copy.ts';
import { highlightRoomMessage } from './room-highlight.ts';
import { renderRoomLinks } from './room-links.ts';
import { roomNames } from './room-names.ts';
import { renderRoomQuestion } from './room-questions.ts';
import { attachReaction, isHumanReaction } from './room-reactions.ts';
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
	let unread = 0;
	let seen = Number(localStorage.getItem('room-seen') ?? '0');
	if (!Number.isSafeInteger(seen) || seen < 0) seen = 0;
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
		room.hidden = !open;
		document.body.classList.toggle('room-open', open);
		get('room-toggle').setAttribute('aria-expanded', String(open));
		if (open) {
			seen = cursor;
			localStorage.setItem('room-seen', String(seen));
			unread = 0;
			badge.textContent = '';
			// The panel is hidden until this runs, and a hidden element has no scroll box, so every
			// scroll-to-bottom that refresh performed while messages were arriving was a no-op that
			// left scrollTop at zero. Without this the room opens on the oldest retained message and
			// the operator scrolls past the rest to reach the conversation they came to read.
			// Reading scrollHeight after unhiding forces the layout the assignment needs.
			messages.scrollTop = messages.scrollHeight;
			input.focus();
		} else get('room-toggle').focus();
	};
	get('room-toggle').addEventListener('click', () => show(room.hidden === true));
	get('room-close').addEventListener('click', () => show(false));
	get('room-cancel-reply').addEventListener('click', () => selectReply(null));
	const append = (event: LocalEvent): void => {
		// Drawn on the message it approves rather than as a post of its own. Falls through to an
		// ordinary post when that message is not on screen, because an approval must never vanish.
		if (isHumanReaction(event) && attachReaction(event)) return;
		const item = document.createElement('article');
		item.className = `room-message ${event.sender.kind}`;
		item.id = `room-message-${event.id}`;
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
		if (event.sender.kind === 'agent' && !event.question) {
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
					message === '👍'
						? 'room-message-action room-message-thumb'
						: 'room-message-action';
				if (message === '👍') action.setAttribute('aria-pressed', 'false');
				action.addEventListener('click', () => {
					if (action.disabled) return;
					// A SECOND APPROVAL IS SWALLOWED (#4536). The icon is a state rather than a tally,
					// so once it is showing as pressed there is nothing a further press could change -
					// and every one that got through was another bare post in everybody's transcript.
					if (action.getAttribute('aria-pressed') === 'true') return;
					action.disabled = true;
					error.hidden = true;
					void window.team
						.roomSend(message, event.id)
						.then(async () => {
							await refresh();
						})
						.catch((cause: unknown) => {
							error.textContent = `Action not confirmed. Check the room before retrying. ${readableError(cause)}`;
							error.hidden = false;
							reportFault({
								level: 'error',
								source: 'room.action',
								text: faultText(cause),
							});
						})
						.finally(() => {
							action.disabled = false;
						});
				});
				item.append(action);
			}
		}
		if (event.image) appendRoomImage(item, event.image, keepFollowing);
		renderRoomQuestion(item, event);
		messages.append(item);
		while (messages.childElementCount > 300) messages.firstElementChild?.remove();
	};
	const refresh = async (): Promise<void> => {
		if (pending) return;
		pending = true;
		const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
		try {
			if (!initialized) {
				cursor = await window.team.roomTail();
				unread = Math.max(0, cursor - seen);
				initialized = true;
			}
			let more = true;
			while (more) {
				const page = await window.team.roomRead(cursor);
				for (const event of page.events) {
					append(event);
					if (room.hidden && event.id > seen) unread++;
				}
				cursor = page.nextCursor;
				more = page.more;
				const state = page.paused
					? 'Halted. Agents can read; sending resumes when you say proceed.'
					: 'Everyone shares this conversation.';
				if (get('room-state').textContent !== state) get('room-state').textContent = state;
				showHalt(page.communication);
			}
			badge.textContent = unread ? String(unread) : '';
			if (!room.hidden) {
				seen = cursor;
				localStorage.setItem('room-seen', String(seen));
			}
			if (atBottom) messages.scrollTop = messages.scrollHeight;
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
	window.addEventListener('beforeunload', () => clearInterval(timer));
	void refresh();
	return (snapshot) => {
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
