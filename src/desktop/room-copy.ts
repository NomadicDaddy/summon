import type { LocalEvent } from '../local-room.ts';
import type { MemberFactsSource } from './member-facts.ts';

import { memberFacts } from './member-facts.ts';

/**
 * What the copy button knows about the teammate who posted: the roster's facts for them.
 * Looked up at click time, so it is the teammate's CURRENT recorded model, account and
 * directory, not the ones that wrote the message - the room does not store those.
 */
export type CopyAuthor = MemberFactsSource;

/** The message as posted, nothing else: what a plain click puts on the clipboard. */
export function messageOnly(event: LocalEvent): string {
	return event.text;
}

/**
 * The message with its provenance above it, for a Shift+click (Phillip's session ask,
 * 2026-10-08): the message number, who, the full local date and time with its zone, the
 * teammate's settings at copy time, the message it replied to,
 * then the text after a blank line.
 */
export function messageWithDetails(
	event: LocalEvent,
	author: CopyAuthor | undefined,
	stamp: (instant: Date) => string = localStamp,
): string {
	const who = event.sender.kind === 'user' ? `${event.sender.id} (you)` : event.sender.id;
	const lines = [`#${event.id} · ${who} · ${stamp(new Date(event.at))}${sourceNote(event)}`];
	if (event.sender.kind === 'agent') lines.push(settingsLine(author));
	if (event.replyTo !== null) lines.push(`Reply to #${event.replyTo}`);
	return `${lines.join('\n')}\n\n${event.text}`;
}

function sourceNote(event: LocalEvent): string {
	return event.source === 'local' ? '' : ` · ${event.source}`;
}

/**
 * The session header's line for the teammate, read from the roster at copy time rather than
 * from historical message metadata (Phillip #7999). A missing roster entry stays explicit.
 */
function settingsLine(author: CopyAuthor | undefined): string {
	return author ? memberFacts(author).join(' · ') : 'Not on the roster';
}

/** Local wall-clock with the zone named, so a pasted stamp means the same thing elsewhere. */
function localStamp(instant: Date): string {
	return instant.toLocaleString(undefined, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		timeZoneName: 'short',
	});
}

/**
 * The copy control for one message. The icon is a stroke of currentColor so it dims and lights
 * with the other message actions. The click reads the modifier at click time: a plain click (or
 * Enter on the focused button) copies the message alone, Shift+click (or Shift+Enter) copies it
 * with its details. `copy` is the window's clipboard write; `failed` receives the reason when it
 * refuses, and the button reports "Copied" on itself for a moment because feedback that appears
 * anywhere other than where the click happened reads as no feedback (#4529).
 */
export function copyButton(
	event: LocalEvent,
	authorOf: (slug: string) => CopyAuthor | undefined,
	copy: (text: string) => Promise<void>,
	failed: (cause: unknown) => void,
): HTMLButtonElement {
	const button = document.createElement('button');
	button.className = 'room-message-action room-message-copy';
	button.title = 'Copy this message. Shift+click copies it with who, model, time and number.';
	const label = `Copy message #${event.id}`;
	button.setAttribute('aria-label', label);
	const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	icon.setAttribute('aria-hidden', 'true');
	const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
	use.setAttribute('href', '#copy-mark');
	icon.append(use);
	button.append(icon);
	let reset: ReturnType<typeof setTimeout> | undefined;
	// In flight by flag and aria-disabled, never `disabled`: a focused button that becomes
	// disabled drops focus to the page in Chromium, so a keyboard user's next Enter did nothing
	// (measured: focus on <body> after 6 of 8 copies; Morticia c71c4107).
	let copying = false;
	button.addEventListener('click', (click) => {
		if (copying) return;
		copying = true;
		button.setAttribute('aria-disabled', 'true');
		const text = click.shiftKey
			? messageWithDetails(event, authorOf(event.sender.id))
			: messageOnly(event);
		void copy(text)
			.then(() => {
				button.dataset.copied = 'true';
				button.setAttribute('aria-label', `Copied message #${event.id}`);
				clearTimeout(reset);
				reset = setTimeout(() => {
					delete button.dataset.copied;
					button.setAttribute('aria-label', label);
				}, 1500);
			})
			.catch(failed)
			.finally(() => {
				copying = false;
				button.removeAttribute('aria-disabled');
			});
	});
	return button;
}
