import { faultText, reportFault } from './fault-report.ts';

/**
 * The notepad's notice: the one block between the hint line and the editor that asks for a
 * decision or reports why saving is off. It renders state and reports choices; the notepad
 * controller owns every read, save, localStorage access and the editor panes.
 *
 * Absent in quiet states. Each state the controller passes is complete, so precedence (a read
 * failure over an older conflict) is decided by the controller choosing which state to pass.
 */

export type NotepadNoticeState =
	| { kind: 'quiet' }
	| {
			kind: 'conflict';
			/** The notepad changed on disk again after Keep my draft, before the draft was saved. */
			changedAgain: boolean;
			/** True while I/O is pending; no choice can be made. */
			disabled: boolean;
			/** The fresh disk version the draft conflicts with, shown read-only on request. */
			diskRevision: string;
			diskText: string;
	  }
	| { kind: 'invalid-draft'; disabled: boolean }
	| { kind: 'read-failure'; disabled: boolean; error: string };

export interface NotepadNoticeCallbacks {
	/** Fresh read, then delete the unreadable stored draft. Only the controller touches storage. */
	onDiscardInvalidDraft: () => void;
	onKeepDraft: () => void;
	onLoadDisk: () => void;
	/**
	 * Focus was inside the notice or the disk view when they were hidden, so it would otherwise be
	 * left on a hidden element. The controller returns it to its editor, as after a choice.
	 */
	onReleaseFocus: () => void;
	onRetry: () => void;
	/**
	 * The editor slot should show the disk version (true) or the draft (false). Called on the
	 * Show disk version / Show my draft toggle, and with false when a notice that was showing the
	 * disk version is replaced. Previewing never chooses anything.
	 */
	onViewChange: (showingDisk: boolean) => void;
}

export interface NotepadNotice {
	/** Read-only disk version for the editor slot, after the textarea. Hidden unless toggled on. */
	diskView: HTMLElement;
	/** Insert between the hint line and the textarea. */
	root: HTMLElement;
	update: (state: NotepadNoticeState) => void;
}

const HEADING_ID = 'notepad-notice-heading';

/** An error message as a sentence: errno messages such as EISDIR end without punctuation. */
function sentence(text: string): string {
	const trimmed = text.trim();
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
	const element = document.createElement('button');
	element.type = 'button';
	element.textContent = label;
	element.addEventListener('click', onClick);
	return element;
}

/** A choice with its consequence written beside it, so neither needs a confirm(). */
function choice(control: HTMLButtonElement, consequence: string): HTMLDivElement {
	const row = document.createElement('div');
	row.className = 'notepad-notice-choice';
	const text = document.createElement('span');
	text.textContent = consequence;
	row.append(control, text);
	return row;
}

/** The identity of a notice state for focus: a new identity moves focus to the heading. */
function noticeIdentity(state: NotepadNoticeState): string {
	return state.kind === 'conflict' && state.changedAgain ? 'conflict-again' : state.kind;
}

export function createNotepadNotice(callbacks: NotepadNoticeCallbacks): NotepadNotice {
	let identity = 'quiet';
	let showingDisk = false;
	const root = document.createElement('div');
	root.className = 'notepad-notice';
	root.hidden = true;
	root.setAttribute('role', 'group');
	root.setAttribute('aria-labelledby', HEADING_ID);
	const heading = document.createElement('h3');
	heading.id = HEADING_ID;
	heading.className = 'notepad-notice-heading';
	heading.tabIndex = -1;
	const body = document.createElement('p');
	const choices = document.createElement('div');
	choices.className = 'notepad-notice-choices';
	const viewToggle = button('Show disk version', () => setShowingDisk(!showingDisk));
	viewToggle.className = 'notepad-notice-quiet';
	root.append(heading, body, choices);

	const diskView = document.createElement('pre');
	diskView.className = 'notepad-disk-view';
	diskView.hidden = true;
	diskView.tabIndex = 0;
	diskView.setAttribute('role', 'region');
	diskView.setAttribute('aria-label', 'Disk version, read only');

	const keep = button('Keep my draft', callbacks.onKeepDraft);
	const load = button('Load disk version', callbacks.onLoadDisk);
	const retry = button('Try again', callbacks.onRetry);
	const discard = button('Discard stored draft', callbacks.onDiscardInvalidDraft);
	const keepChoice = choice(keep, 'The next save replaces the version on disk.');
	const loadChoice = choice(load, 'Replaces the editor and discards your draft.');

	function setShowingDisk(next: boolean): void {
		if (next === showingDisk) return;
		showingDisk = next;
		diskView.hidden = !next;
		viewToggle.textContent = next ? 'Show my draft' : 'Show disk version';
		callbacks.onViewChange(next);
	}

	function update(state: NotepadNoticeState): void {
		const focused = document.activeElement;
		const hadFocus = root.contains(focused) || diskView.contains(focused);
		if (state.kind !== 'conflict') setShowingDisk(false);
		const nextIdentity = noticeIdentity(state);
		const entered = nextIdentity !== identity;
		identity = nextIdentity;
		root.hidden = state.kind === 'quiet';
		root.dataset.tone = state.kind === 'conflict' ? 'warning' : 'danger';
		switch (state.kind) {
			case 'quiet':
				if (hadFocus) callbacks.onReleaseFocus();
				return;
			case 'conflict':
				heading.textContent = state.changedAgain
					? 'The notepad changed on disk again before your draft was saved.'
					: 'The notepad changed on disk while you had unsaved edits.';
				// Reported once per notice, not per re-render: `entered` is the identity change.
				if (entered)
					reportFault({
						level: 'warning',
						source: 'notepad.conflict',
						text: heading.textContent,
					});
				body.textContent =
					'Your draft and the disk version are kept separately. Choose which version to use.';
				diskView.textContent = state.diskText;
				diskView.dataset.revision = state.diskRevision;
				keep.disabled = load.disabled = state.disabled;
				choices.replaceChildren(keepChoice, loadChoice, viewToggle);
				break;
			case 'read-failure':
				heading.textContent = "Couldn't verify the notepad.";
				body.textContent = `${sentence(state.error)} Your text is kept in this window. Saving is off until it can be verified again.`;
				if (entered)
					reportFault({
						level: 'error',
						source: 'notepad.read',
						text: faultText(state.error),
					});
				retry.disabled = state.disabled;
				choices.replaceChildren(retry);
				break;
			case 'invalid-draft':
				heading.textContent = "A stored recovery draft couldn't be read.";
				// The heading only: the stored draft itself never leaves this window.
				if (entered)
					reportFault({
						level: 'error',
						source: 'notepad.draft',
						text: heading.textContent,
					});
				body.textContent =
					'It is kept exactly as stored and has not been loaded. Discarding deletes it after a fresh read of the notepad.';
				discard.disabled = state.disabled;
				choices.replaceChildren(discard);
				break;
		}
		// A newly entered state is read before its choices; neither conflict choice takes focus.
		if (entered) heading.focus();
	}

	return { diskView, root, update };
}
