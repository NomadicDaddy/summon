import { dismissOnOutsideClick } from './dialog-dismiss.ts';
import { setupJump } from './jump.ts';
import { setupMemberKeys } from './member-keys.ts';
/**
 * The keyboard shortcuts this window actually has, shown on `?`.
 *
 * Phillip asked for this at room #3904 with a specific symptom: he could not remember the notepad
 * keypress. The reason is that `Ctrl+Shift+N` was documented in exactly one place - the hint line
 * INSIDE the notepad dialog - so the only way to read the shortcut was to already know it. Every
 * other binding here had no user-facing documentation at all.
 *
 * The list is maintained by hand against the handlers rather than derived from them, because a
 * binding and its description are different things: `event.code === 'KeyN'` cannot tell a reader
 * that the notepad toggles rather than opens. The cost is that this file has to be edited when a
 * binding changes, and a wrong entry here is worse than no entry - so each one below names the
 * module that owns it.
 */

interface Shortcut {
	/** Keys as a reader would say them, each rendered as its own <kbd>. */
	keys: string[];
	/** What it does, in the imperative. */
	label: string;
	/** Where it only applies, when it is not global. */
	scope?: string;
}

interface ShortcutGroup {
	heading: string;
	shortcuts: Shortcut[];
}

const GROUPS: ShortcutGroup[] = [
	{
		heading: 'Anywhere',
		shortcuts: [
			// notepad.ts:170
			{ keys: ['Ctrl', 'Shift', 'N'], label: 'Open or close the notepad' },
			// jump.ts
			{
				keys: ['Ctrl', 'Shift', 'J'],
				label: 'Jump to a Room message, a Board card or a teammate',
			},
			// member-keys.ts
			{
				keys: ['Ctrl', '1…9'],
				label: 'Select the teammate whose sidebar number is the one pressed',
			},
			{
				keys: ['Ctrl', '0'],
				label: 'Select the PM, numbered 0, even when a filter hides it',
			},
			// operator-pane.ts:108
			{ keys: ['Ctrl', '`'], label: 'Open or close the terminal' },
			{ keys: ['?'], label: 'Show this list' },
		],
	},
	{
		heading: 'Writing a message',
		shortcuts: [
			// room.ts:41
			{ keys: ['Enter'], label: 'Send' },
			{ keys: ['Shift', 'Enter'], label: 'Start a new line instead of sending' },
			// composer-history.ts:52 - only when the caret has no line above/below it
			{
				keys: ['↑'],
				label: 'Recall the previous message you sent',
				scope: 'single-line only',
			},
			{
				keys: ['↓'],
				label: 'Move forward again through what you sent',
				scope: 'single-line only',
			},
			// room-attachments.ts:44
			{ keys: ['Alt', 'V'], label: 'Paste an image from the clipboard' },
		],
	},
	{
		heading: 'Notepad',
		shortcuts: [
			// notepad.ts:174
			{ keys: ['Ctrl', 'S'], label: 'Save' },
			{ keys: ['Esc'], label: 'Close' },
			// notepad.ts Ctrl+F handler and notepad-find.ts (#7628)
			{ keys: ['Ctrl', 'F'], label: 'Find in the note' },
			{ keys: ['Enter'], label: 'Next match', scope: 'find bar' },
			{ keys: ['Shift', 'Enter'], label: 'Previous match', scope: 'find bar' },
			{ keys: ['F3'], label: 'Next match; Shift+F3 the previous', scope: 'find bar open' },
			{ keys: ['Esc'], label: 'Close the find bar', scope: 'find bar' },
		],
	},
	{
		heading: 'Resizing a pane',
		shortcuts: [
			// splitters.ts:159-166 - the handle must have focus, which Tab gives it
			{ keys: ['←', '→'], label: 'Move a vertical divider', scope: 'divider focused' },
			{ keys: ['↑', '↓'], label: 'Move a horizontal divider', scope: 'divider focused' },
			{ keys: ['Home'], label: 'Collapse the pane', scope: 'divider focused' },
			{ keys: ['End'], label: 'Expand the pane fully', scope: 'divider focused' },
		],
	},
];

/** The element kinds that own a keystroke themselves, so `?` must reach them as a character. */
const TYPING_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];

/**
 * True when the keystroke belongs to whatever the user is typing into rather than to the window.
 *
 * Duck-typed on `tagName` rather than tested with `instanceof HTMLElement`, for one reason: the
 * element-focus path cannot be driven from the Electron capture probe - a probe window never takes
 * OS focus, so `focus()` leaves `document.activeElement` on BODY and the guard is never exercised.
 * Shaped this way it is reachable from bun:test with a plain object, which is where its regression
 * cover lives. The probe proves the toggle; this shape is what lets a test prove the exemption.
 */
export function isTyping(
	target: { isContentEditable?: boolean; tagName?: string } | null,
): boolean {
	if (!target || typeof target.tagName !== 'string') return false;
	if (target.isContentEditable === true) return true;
	return TYPING_TAGS.includes(target.tagName);
}

function renderGroup(group: ShortcutGroup): HTMLElement {
	const section = document.createElement('section');
	const heading = document.createElement('h3');
	heading.textContent = group.heading;
	const list = document.createElement('dl');
	for (const shortcut of group.shortcuts) {
		const keys = document.createElement('dt');
		for (const [index, key] of shortcut.keys.entries()) {
			if (index > 0) keys.append(document.createTextNode(' '));
			const kbd = document.createElement('kbd');
			kbd.textContent = key;
			keys.append(kbd);
		}
		const label = document.createElement('dd');
		label.textContent = shortcut.label;
		if (shortcut.scope !== undefined) {
			const scope = document.createElement('span');
			scope.className = 'shortcut-scope';
			scope.textContent = shortcut.scope;
			label.append(' ', scope);
		}
		list.append(keys, label);
	}
	section.append(heading, list);
	return section;
}

export function setupShortcuts(): void {
	// Register the window's navigation shortcuts together.
	setupJump();
	setupMemberKeys();
	const dialog = document.createElement('dialog');
	dialog.id = 'shortcuts';
	dismissOnOutsideClick(dialog);
	dialog.setAttribute('aria-labelledby', 'shortcuts-title');

	const heading = document.createElement('h2');
	heading.id = 'shortcuts-title';
	heading.textContent = 'Keyboard shortcuts';

	const hint = document.createElement('p');
	hint.className = 'shortcuts-hint';
	hint.textContent = 'Press ? anywhere except while typing · Esc to close';

	const body = document.createElement('div');
	body.className = 'shortcuts-body';
	for (const group of GROUPS) body.append(renderGroup(group));

	const close = document.createElement('button');
	close.textContent = 'Close';
	close.type = 'button';
	close.addEventListener('click', () => {
		dialog.close();
	});

	const actions = document.createElement('div');
	actions.className = 'shortcuts-actions';
	actions.append(close);

	dialog.append(heading, hint, body, actions);
	document.body.append(dialog);

	document.addEventListener(
		'keydown',
		(event) => {
			// `?` is Shift+/ on most layouts and AltGr-something on others, so match the character
			// rather than a code. Modifier-free check excludes Ctrl+? and friends.
			if (event.key !== '?' || event.ctrlKey || event.altKey || event.metaKey) return;
			// EventTarget carries no element properties, so narrow to the shape the guard reads.
			if (isTyping(event.target as null | { isContentEditable?: boolean; tagName?: string }))
				return;
			event.preventDefault();
			if (event.repeat) return;
			if (dialog.open) dialog.close();
			else dialog.showModal();
		},
		true,
	);
}
