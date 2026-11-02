import { faultText, reportFault } from './fault-report.ts';
import { readableError } from './ipc-error.ts';

/**
 * The window's one error box: show a message, clear it, and let the reader dismiss it.
 *
 * It lives here rather than in renderer.ts for the plain reason that renderer.ts sits one line
 * under its limit and this is a self-contained thing - three elements and two verbs - that the
 * rest of that file only ever calls.
 *
 * WHY IT CAN BE DISMISSED (#5269). `clear` runs when the next user operation starts, and that was
 * the only way the box ever went away. But `show` is also handed to the diary, the repos panel and
 * the board refresh, which fail in the background with no user operation behind them. An error
 * from one of those had no clearing path at all: the reader sat under a banner they had not caused
 * and could not remove, with no way to tell what had prompted it.
 *
 * Dismissal is manual and only manual. An error that removed itself would take its information
 * with it, and what was asked for was a way to dismiss one, not for errors to expire.
 *
 * TWO VERBS FOR SHOWING, because the journal must not hear things twice. `show` is for an error
 * this window is the first to see: it draws it and reports it under the call site that caught it.
 * `display` only draws: it is for a main-process event whose recording was already attempted and for a
 * teammate fault being shown again when their row is selected.
 */
export interface ErrorBanner {
	clear: () => void;
	display: (text: string) => void;
	/** A reporter bound to one call site, for surfaces that take an `(error) => void`. */
	from: (source: string) => (error: unknown) => void;
	show: (error: unknown, source?: string, member?: string) => void;
}

export function setupErrorBanner(element: (id: string) => HTMLElement): ErrorBanner {
	const box = element('error');
	const message = element('error-message');
	const clear = (): void => {
		box.hidden = true;
	};
	element('error-dismiss').addEventListener('click', clear);
	const display = (text: string): void => {
		// The message element, not the box: writing textContent on the box would delete the
		// dismiss button along with the old text, and the next error would have no way out.
		message.textContent = text;
		box.hidden = false;
	};
	const show = (error: unknown, source = 'banner', member?: string): void => {
		// Every surface that fails into this box gets the reason, not Electron's transport wrapper.
		display(readableError(error));
		reportFault({
			level: 'error',
			source,
			text: faultText(error),
			...(member === undefined ? {} : { member }),
		});
	};
	return {
		clear,
		display,
		from: (source) => (error) => show(error, source),
		show,
	};
}
