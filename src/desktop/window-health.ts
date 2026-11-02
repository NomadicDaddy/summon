import { type RuntimeFaultInput, runtimeFaultText } from '../runtime-fault-model.ts';

/**
 * What the Team Window records when its page stops working (C14, blank-team-window-diagnosis).
 *
 * The 0.16.0 blank window (#7088) left nothing behind: only a renderer that EXITS was recorded, so a
 * renderer that hung, a page that failed to load and a preload that threw all looked like a quiet,
 * healthy window that happened to be blank. Each of those is now a fault journal line, ending with
 * the page's last-known layout and its age (page-state.ts), so the next blank window can say which
 * of them it was. An absent line is not proof that none happened: Chromium reports a hang only when
 * an input event goes unanswered, and a journal write can itself fail.
 *
 * Recording only. Nothing here reloads or restarts the window: closing it stops the sessions it owns,
 * and a reload is not known to keep them, so recovery stays the operator's decision.
 */
interface WindowEvents {
	on(
		event: 'render-process-gone',
		listener: (event: unknown, details: { reason: string; exitCode: number }) => void,
	): unknown;
	on(event: 'unresponsive' | 'responsive', listener: () => void): unknown;
	on(
		event: 'did-fail-load',
		listener: (
			event: unknown,
			errorCode: number,
			errorDescription: string,
			validatedURL: string,
			isMainFrame: boolean,
		) => void,
	): unknown;
	on(
		event: 'preload-error',
		listener: (event: unknown, preloadPath: string, error: Error) => void,
	): unknown;
}

const seconds = (ms: number): string => `${String(Math.round(ms / 100) / 10)} s`;

/**
 * Text that arrives from outside (a crash reason, a load description, a preload error), put through
 * the journal's own privacy formatter BEFORE the page state is appended: first line only, payloads
 * and credentials redacted, as for any other record (morgan on c19fac8: joining lines brought a
 * stack or payload in). Formatted first, a redaction that runs to the end of the line or replaces
 * the whole text stops at the reason and cannot take the page state with it (Roger on c19fac8).
 * Capped so the reason and the page state together stay inside the journal's 2048 characters.
 */
const outside = (text: string): string => {
	if (!text.trim()) return '';
	const safe = runtimeFaultText(text);
	return safe.length > 1000 ? `${safe.slice(0, 1000)}...` : safe;
};

/**
 * Hooks the window's renderer events to the fault journal.
 * @param contents The Team Window's webContents (or anything with the same events, for tests).
 * @param report Writes one fault journal line; failures are the caller's to swallow.
 * @param onGone Runs after a renderer exit is recorded; the window cannot recover from that.
 * @param lastPage The page's last-known layout in words, never asked of the renderer itself.
 * @param now The clock, so a hang's length can be told.
 */
export function watchWindowHealth(
	contents: WindowEvents,
	report: (input: RuntimeFaultInput) => Promise<void>,
	onGone: () => void,
	lastPage: () => string,
	now: () => number = Date.now,
): void {
	const send = (input: RuntimeFaultInput): void => void report(input).catch(() => {});
	contents.on('render-process-gone', (_event, details) => {
		send({
			level: 'error',
			source: 'window.renderer-exit',
			text: `Renderer ended: ${outside(details.reason)}; exit code ${String(details.exitCode)}. ${lastPage()}`,
		});
		onGone();
	});
	let stuckSince: number | null = null;
	contents.on('unresponsive', () => {
		if (stuckSince !== null) return;
		stuckSince = now();
		send({
			level: 'warning',
			source: 'window.renderer-unresponsive',
			text: `The Team Window stopped responding: its page is busy or hung. Sessions keep running; the window may recover by itself. ${lastPage()}`,
		});
	});
	contents.on('responsive', () => {
		if (stuckSince === null) return;
		const length = now() - stuckSince;
		stuckSince = null;
		send({
			level: 'warning',
			source: 'window.renderer-responsive',
			text: `The Team Window is responding again after ${seconds(length)}.`,
		});
	});
	contents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
		// A sub-frame (an embedded preview) failing is that frame's problem, not a blank window.
		if (!isMainFrame) return;
		send({
			level: 'error',
			source: 'window.load-failed',
			text: `The Team Window page did not load: ${outside(errorDescription) || 'no description'} (${String(errorCode)}). ${lastPage()}`,
		});
	});
	contents.on('preload-error', (_event, _path, error) => {
		send({
			level: 'error',
			source: 'window.preload-failed',
			text: `The Team Window bridge did not load: ${outside(error.message)} ${lastPage()}`,
		});
	});
}
