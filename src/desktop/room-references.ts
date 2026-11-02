import type { LocalEvent } from '../local-room.ts';

import { dismissOnOutsideClick } from './dialog-dismiss.ts';
import { reportFault } from './fault-report.ts';
import { appendRoomImage } from './room-attachments.ts';
import { highlightRoomMessage } from './room-highlight.ts';

export function referenceIds(value: string): { index: number; label: string; id: number }[] {
	return [...value.matchAll(/(?<![\p{L}\p{N}_/#])#([1-9]\d*)(?![\p{L}\p{N}_])/gu)]
		.map((match) => ({ index: match.index, label: match[0], id: Number(match[1]) }))
		.filter(({ id }) => Number.isSafeInteger(id));
}

/** Link text nodes only; preserve name badges and never interpret message text as HTML. */
export function linkReferences(node: HTMLElement): void {
	const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
	const texts: Text[] = [];
	while (walker.nextNode()) {
		const text = walker.currentNode as Text;
		if (!text.parentElement?.closest('a')) texts.push(text);
	}
	for (const text of texts) {
		const parts: (string | HTMLElement)[] = [];
		let offset = 0;
		for (const match of referenceIds(text.data)) {
			parts.push(text.data.slice(offset, match.index));
			const link = document.createElement('a');
			link.href = `#room-message-${match.id}`;
			link.dataset['roomReference'] = String(match.id);
			link.textContent = match.label;
			link.title = `View message #${match.id}`;
			parts.push(link);
			offset = match.index + match.label.length;
		}
		if (offset === 0) continue;
		parts.push(text.data.slice(offset));
		const fragment = document.createDocumentFragment();
		fragment.append(...parts);
		text.replaceWith(fragment);
	}
}

export function setupRoomReferences(
	messages: HTMLElement,
	decorate: (node: HTMLElement, text: string) => void,
): void {
	const dialog = document.createElement('dialog');
	dialog.className = 'room-reference-dialog';
	dialog.setAttribute('aria-label', 'Referenced room message');
	dismissOnOutsideClick(dialog);
	const close = document.createElement('button');
	close.textContent = 'Close';
	close.type = 'button';
	close.addEventListener('click', () => dialog.close());
	const content = document.createElement('div');
	content.setAttribute('aria-live', 'polite');
	dialog.append(close, content);
	document.body.append(dialog);
	let request = 0;
	let viewed: number | undefined;
	let history: number[] = [];
	const addBack = (target: HTMLElement): void => {
		const previous = history.at(-1);
		if (previous === undefined) return;
		const back = document.createElement('a');
		back.className = 'room-reference-back';
		back.href = `#room-message-${previous}`;
		back.dataset.roomReference = String(previous);
		back.dataset.roomBack = 'true';
		back.textContent = `Back to #${previous}`;
		target.prepend(back);
	};
	dialog.addEventListener('close', () => {
		request++;
	});
	const preview = (event: LocalEvent): HTMLElement => {
		const item = document.createElement('article');
		item.className = 'room-message';
		item.dataset.roomMessageId = String(event.id);
		const heading = document.createElement('h3');
		heading.textContent = `#${event.id} · ${event.sender.kind === 'user' ? 'You' : event.sender.id}`;
		const when = document.createElement('small');
		when.textContent = new Date(event.at).toLocaleString();
		item.append(heading, when);
		if (event.replyTo !== null) {
			const context = document.createElement('p');
			context.textContent = `Reply to #${event.replyTo}`;
			linkReferences(context);
			item.append(context);
		}
		const text = document.createElement('p');
		decorate(text, highlightRoomMessage(item, event));
		item.append(text);
		// A preview in the reference dialog has no log of its own to keep pinned.
		if (event.image) appendRoomImage(item, event.image, () => undefined);
		return item;
	};
	const navigate = async (id: number): Promise<void> => {
		const current = ++request;
		viewed = id;
		for (const root of [messages, dialog])
			root.querySelectorAll('.room-reference-back').forEach((back) => back.remove());
		const target = document.getElementById(`room-message-${id}`);
		if (target && messages.contains(target)) {
			dialog.close();
			messages
				.querySelector('.room-reference-target')
				?.classList.remove('room-reference-target');
			target.classList.add('room-reference-target');
			addBack(target);
			target.tabIndex = -1;
			target.focus({ preventScroll: true });
			target.scrollIntoView({ block: 'center' });
			return;
		}
		content.textContent = `Loading message #${id}…`;
		addBack(content);
		if (!dialog.open) dialog.showModal();
		try {
			const page = await window.team.roomRead(id - 1);
			if (request !== current) return;
			const event = page.events.find((candidate) => candidate.id === id);
			if (!event) throw new Error('Message not found.');
			const item = preview(event);
			addBack(item);
			content.replaceChildren(item);
		} catch {
			if (request === current) {
				content.textContent = `Message #${id} could not be loaded.`;
				reportFault({
					level: 'error',
					source: 'room.reference',
					text: content.textContent,
				});
				addBack(content);
			}
		}
	};
	const click = (event: MouseEvent): void => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const link = target.closest<HTMLAnchorElement>('a[data-room-reference]');
		if (!link) return;
		event.preventDefault();
		const id = Number(link.dataset.roomReference);
		if (link.dataset.roomBack) history.pop();
		else {
			const message = link.closest<HTMLElement>('.room-message');
			const source = Number(
				message?.dataset.roomMessageId ?? message?.id.replace('room-message-', ''),
			);
			if (source !== viewed) history = [];
			if (Number.isSafeInteger(source) && source > 0 && source !== id) history.push(source);
		}
		void navigate(id);
	};
	messages.addEventListener('click', click);
	dialog.addEventListener('click', click);
	// Jump (card e6619a2e) asks for a message by number from outside any link. It starts a fresh
	// trail: there is no message it came from to go back to.
	messages.addEventListener('room-jump', (event) => {
		const id = (event as CustomEvent<unknown>).detail;
		if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return;
		history = [];
		void navigate(id);
	});
}
