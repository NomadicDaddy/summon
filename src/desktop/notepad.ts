import { dismissOnOutsideClick } from './dialog-dismiss.ts';
import { faultText, reportFault } from './fault-report.ts';
import { readableError } from './ipc-error.ts';
import { placeCaret, rememberCaret } from './notepad-caret.ts';
import { NotepadController } from './notepad-controller.ts';
import { deleteEmptyLine, type Edit, moveLines } from './notepad-editing.ts';
import { setupNotepadFind } from './notepad-find.ts';
import { renderMarkdown } from './notepad-markdown.ts';
import { createNotepadNotice } from './notepad-notice.ts';

export function setupNotepad(): void {
	const dialog = document.createElement('dialog');
	dialog.id = 'notepad';
	dismissOnOutsideClick(dialog);
	dialog.setAttribute('aria-labelledby', 'notepad-title');
	const heading = document.createElement('h2');
	heading.id = 'notepad-title';
	heading.textContent = 'Notepad';
	const hint = document.createElement('p');
	hint.textContent =
		'Ctrl+Shift+N to toggle · Esc to close · Ctrl+S to save · Ctrl+F finds · Ctrl+X deletes an empty line · Alt+Z wraps · Alt+↑/↓ moves a line';
	const text = document.createElement('textarea');
	text.id = 'notepad-text';
	text.setAttribute('aria-label', 'Notepad text');
	text.spellcheck = false;
	const preview = document.createElement('div');
	preview.id = 'notepad-preview';
	preview.hidden = true;
	preview.setAttribute('role', 'region');
	preview.setAttribute('aria-label', 'Markdown preview');
	const mode = document.createElement('button');
	mode.textContent = 'Preview Markdown';
	const status = document.createElement('p');
	status.setAttribute('role', 'status');
	const reload = document.createElement('button');
	reload.textContent = 'Reload from disk';
	const close = document.createElement('button');
	close.textContent = 'Close';
	const actions = document.createElement('div');
	actions.append(mode, reload, close);
	let previewMode = false;
	let showingDisk = false;
	let previousFocus: HTMLElement | null = null;
	const draftKey = 'notepad-draft';
	const controller = new NotepadController(
		{
			read: () => window.team.notepadRead(),
			save: (value, revision) => window.team.notepadSave(value, revision),
		},
		{
			read: () => localStorage.getItem(draftKey),
			write: (value) => localStorage.setItem(draftKey, value),
			clear: () => localStorage.removeItem(draftKey),
		},
		update,
	);
	const notice = createNotepadNotice({
		onKeepDraft: () => controller.keepDraft(),
		onLoadDisk: () => void controller.load(true),
		onRetry: () => void controller.load(),
		onDiscardInvalidDraft: () => void controller.load(true),
		onViewChange: (value) => {
			showingDisk = value;
			updatePanes();
		},
		onReleaseFocus: focusEditor,
	});
	// Ctrl+F (#7628) searches whichever pane is showing: the editor, the preview or the saved copy.
	const find = setupNotepadFind({
		text,
		domPane: () => (showingDisk ? notice.diskView : previewMode ? preview : null),
		focusBack: () => mode.focus(),
	});
	dialog.append(heading, hint, notice.root, find.bar, find.editor, notice.diskView, preview);
	dialog.append(status, actions);
	document.body.append(dialog);

	function updatePanes(): void {
		text.hidden = previewMode || showingDisk;
		find.editor.hidden = text.hidden;
		preview.hidden = !previewMode || showingDisk;
		mode.disabled = showingDisk;
		mode.textContent = previewMode ? 'Edit Markdown' : 'Preview Markdown';
		find.refresh();
	}
	function focusEditor(): void {
		previewMode = false;
		updatePanes();
		if (dialog.open) text.focus();
	}
	// A failed save is reported once per failure episode: not on every repaint of the same status,
	// and again if the same failure returns after a status that was not a failure.
	let reportedFailure = '';
	// Text that arrives from the controller (an open, a reload, a resolved conflict) lands the caret
	// where it was left for that exact text, otherwise at the top (#7047); the memory is taken as
	// the dialog closes or the window unloads.
	const caretStore = {
		read: () => localStorage.getItem('notepad-caret'),
		write: (value: string) => localStorage.setItem('notepad-caret', value),
	};
	function restoreCaret(): void {
		const place = placeCaret(caretStore, text.value);
		text.setSelectionRange(place.start, place.end);
		text.scrollTop = place.scrollTop;
	}
	function keepCaret(): void {
		rememberCaret(
			caretStore,
			text.value,
			text.selectionStart,
			text.selectionEnd,
			text.scrollTop,
		);
	}
	function update(): void {
		const changed = text.value !== controller.state.text;
		if (changed) {
			text.value = controller.state.text;
			restoreCaret();
			find.refresh();
		}
		text.disabled = controller.editorDisabled;
		status.textContent = controller.status;
		if (!controller.status.startsWith('Save failed')) reportedFailure = '';
		else if (controller.status !== reportedFailure) {
			reportedFailure = controller.status;
			reportFault({ level: 'error', source: 'notepad.save', text: controller.status });
		}
		reload.disabled = controller.loading || controller.saving;
		reload.hidden = controller.notice.kind !== 'quiet';
		notice.update(controller.notice);
		if (changed && previewMode && !showingDisk) renderPreview();
		updatePreviewControls();
	}
	function updatePreviewControls(): void {
		for (const box of preview.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
			box.disabled = controller.editorDisabled || box.dataset.taskOffset === undefined;
	}
	function renderPreview(): void {
		const scroll = preview.scrollTop;
		const focused =
			document.activeElement instanceof HTMLInputElement
				? document.activeElement.dataset.taskOffset
				: undefined;
		preview.replaceChildren(
			renderMarkdown(text.value, (value) => {
				if (controller.editorDisabled) return;
				text.value = value;
				controller.edit(value);
				renderPreview();
			}),
		);
		updatePreviewControls();
		preview.scrollTop = scroll;
		find.refresh();
		if (focused !== undefined)
			preview.querySelector<HTMLInputElement>(`[data-task-offset="${focused}"]`)?.focus();
	}
	// Keep preview links on the existing URL boundary; fragments scroll within the preview.
	preview.addEventListener('click', (event) => {
		const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
		if (!(link instanceof HTMLAnchorElement)) return;
		event.preventDefault();
		const href = link.getAttribute('href') ?? '';
		if (href.startsWith('#')) {
			let anchor = href.slice(1);
			try {
				anchor = decodeURIComponent(anchor);
			} catch {
				/* Match a malformed escape as written. */
			}
			anchor = anchor.toLowerCase();
			const heading = [...preview.querySelectorAll<HTMLElement>('[data-anchor]')].find(
				(candidate) => candidate.dataset.anchor === anchor,
			);
			if (heading) heading.scrollIntoView({ block: 'start' });
			else status.textContent = `No heading matches ${href}.`;
			return;
		}
		window.team.openRoomUrl(link.href).catch((cause: unknown) => {
			status.textContent = `Link not opened: ${readableError(cause)}`;
			reportFault({ level: 'error', source: 'notepad.link', text: faultText(cause) });
		});
	});
	mode.addEventListener('click', () => {
		previewMode = !previewMode;
		updatePanes();
		if (previewMode) renderPreview();
		else text.focus();
	});
	async function open(): Promise<void> {
		previousFocus =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialog.showModal();
		await controller.load();
		if (dialog.open && controller.notice.kind === 'quiet') (previewMode ? mode : text).focus();
	}
	text.addEventListener('input', () => {
		controller.edit(text.value);
		find.refresh();
	});
	// Line editing (#7025, #7026, #7028). Wrapping is a per-window preference the way the theme
	// is; the two edits go through the same input path as typing so the draft and save state follow.
	const wrapKey = 'notepad-wrap';
	const applyWrap = (): void => {
		text.wrap = localStorage.getItem(wrapKey) === 'off' ? 'off' : 'soft';
		// The find layer copies the editor's wrapping when it draws (Roger, review of d19323e).
		find.relayout();
	};
	applyWrap();
	const applyEdit = (edit: Edit | undefined): boolean => {
		if (!edit) return false;
		text.value = edit.value;
		text.setSelectionRange(edit.start, edit.end);
		text.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	};
	text.addEventListener('keydown', (event) => {
		if (event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
			if (event.code === 'KeyZ') {
				event.preventDefault();
				localStorage.setItem(wrapKey, text.wrap === 'off' ? 'soft' : 'off');
				applyWrap();
				return;
			}
			if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
				const selection = { start: text.selectionStart, end: text.selectionEnd };
				const direction = event.code === 'ArrowUp' ? 'up' : 'down';
				if (applyEdit(moveLines(text.value, selection, direction))) event.preventDefault();
			}
			return;
		}
		if (event.ctrlKey && !event.altKey && !event.shiftKey && event.code === 'KeyX') {
			const selection = { start: text.selectionStart, end: text.selectionEnd };
			if (applyEdit(deleteEmptyLine(text.value, selection))) event.preventDefault();
		}
	});
	dialog.addEventListener('close', () => {
		find.close(false);
		keepCaret();
		void controller.save();
		previousFocus?.focus();
	});
	close.addEventListener('click', () => dialog.close());
	reload.addEventListener('click', () => void controller.load());
	window.addEventListener('beforeunload', () => {
		if (dialog.open) keepCaret();
		controller.dispose();
	});
	document.addEventListener(
		'keydown',
		(event) => {
			if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyN') {
				event.preventDefault();
				event.stopImmediatePropagation();
				if (!event.repeat) {
					if (dialog.open) dialog.close();
					else void open();
				}
			} else if (dialog.open && event.ctrlKey && !event.altKey && event.code === 'KeyS') {
				event.preventDefault();
				event.stopImmediatePropagation();
				void controller.save(true);
			} else if (dialog.open && event.ctrlKey && !event.altKey && event.code === 'KeyF') {
				event.preventDefault();
				event.stopImmediatePropagation();
				find.open();
			} else if (dialog.open && find.isOpen() && event.key === 'F3') {
				event.preventDefault();
				find.step(event.shiftKey ? -1 : 1);
			}
		},
		true,
	);
}
