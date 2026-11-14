import type { OperatorAwayView } from '../operator-away.ts';
import type { TeamBridge } from './types.ts';

type PresentCause = Parameters<TeamBridge['operatorPresent']>[0];

/** Which field a deliberate keystroke landed in, or null for fields that don't clear Away. */
function inputSurface(target: EventTarget | null): PresentCause | null {
	if (!(target instanceof HTMLElement)) return null;
	// Terminals report themselves, telling keystrokes from terminal replies (terminal-input-origin.ts).
	if (target.classList.contains('xterm-helper-textarea')) return null;
	if (target.id === 'room-text') return 'room-draft';
	if (target.id === 'notepad-text') return 'notepad';
	if (target.closest('#maintenance')) return 'maintenance';
	if (target.closest('#notepad')) return 'search';
	if (
		target instanceof HTMLInputElement &&
		(target.type === 'search' || target.id === 'jump-input')
	)
		return 'search';
	return null;
}

/** "Away", "Away since 14:32" or the failure, for the button's text and title. */
export function awayLabel(view: OperatorAwayView | undefined): { text: string; title: string } {
	if (!view || view.state === 'here')
		return { text: 'Away', title: 'Mark yourself away from the keyboard (Ctrl+Shift+A)' };
	if (view.state === 'unavailable')
		return { text: 'Away ?', title: `${view.error} Press to set Away again (Ctrl+Shift+A).` };
	const since = new Date(view.since).toLocaleTimeString([], {
		hour: '2-digit',
		minute: '2-digit',
	});
	return {
		text: `Away since ${since}`,
		title: 'You are away. Press, or type anywhere, to come back (Ctrl+Shift+A).',
	};
}

/**
 * A physical Ctrl+Shift+A. A dispatched event isn't trusted and never toggles Away (Roger #48243).
 */
export function isAwayShortcut(
	event: Pick<
		KeyboardEvent,
		'altKey' | 'code' | 'ctrlKey' | 'isTrusted' | 'metaKey' | 'shiftKey'
	>,
): boolean {
	return (
		event.isTrusted &&
		event.ctrlKey &&
		event.shiftKey &&
		!event.altKey &&
		!event.metaKey &&
		event.code === 'KeyA'
	);
}

/** At most one presence report each half second while Away shows; a declined report never latches. */
const PRESENCE_REPORT_INTERVAL_MS = 500;
export function shouldReportPresence(
	view: OperatorAwayView | undefined,
	lastReport: number | null,
	now: number,
): boolean {
	if (view?.state !== 'away') return false;
	return lastReport === null || now - lastReport >= PRESENCE_REPORT_INTERVAL_MS;
}

/**
 * The masthead Away toggle and its Ctrl+Shift+A shortcut, plus the renderer's half of auto-clear:
 * trusted keystrokes in a Room draft, Notepad, search or Maintenance field while Away, reported at
 * most every half second. Synthetic input (macro inserts, programmatic edits) never counts.
 */
export function setupAwayControl(onError: (error: unknown) => void): {
	update: (view: OperatorAwayView | undefined) => void;
	present: (cause: PresentCause) => void;
} {
	const header = document.querySelector('#sidebar > header');
	const button = document.createElement('button');
	button.id = 'away-toggle';
	button.type = 'button';
	button.setAttribute('aria-pressed', 'false');
	header?.append(button);
	let view: OperatorAwayView | undefined;
	let pending = false;
	let lastReport: number | null = null;
	const render = (): void => {
		const label = awayLabel(view);
		button.textContent = pending ? 'Saving…' : label.text;
		button.title = label.title;
		button.setAttribute('aria-pressed', view?.state === 'away' ? 'true' : 'false');
		button.setAttribute('aria-busy', pending ? 'true' : 'false');
		button.classList.toggle('is-away', view?.state === 'away');
		button.classList.toggle('is-unavailable', view?.state === 'unavailable');
	};
	const toggle = (cause: 'button' | 'shortcut'): void => {
		if (pending) return;
		pending = true;
		render();
		void window.team
			.toggleAway(cause)
			.then((result) => {
				view = result.view;
			})
			.catch(onError)
			.finally(() => {
				pending = false;
				render();
			});
	};
	const present = (cause: PresentCause): void => {
		const now = Date.now();
		if (!shouldReportPresence(view, lastReport, now)) return;
		lastReport = now;
		// Main stamps the report when it arrives, on the clock that stamped the Away.
		window.team.operatorPresent(cause);
	};
	button.addEventListener('click', () => toggle('button'));
	document.addEventListener(
		'keydown',
		(event) => {
			if (!isAwayShortcut(event)) return;
			// Taken before a focused terminal or field sees it, so the toggle can't clear itself.
			event.preventDefault();
			event.stopImmediatePropagation();
			if (!event.repeat) toggle('shortcut');
		},
		true,
	);
	const observe = (event: Event): void => {
		if (!event.isTrusted) return;
		const cause = inputSurface(event.target);
		if (cause) present(cause);
	};
	document.addEventListener('beforeinput', observe, true);
	// Checkboxes and selects in Maintenance change without text input.
	document.addEventListener('change', observe, true);
	render();
	return {
		update: (next) => {
			view = next;
			render();
		},
		present,
	};
}
