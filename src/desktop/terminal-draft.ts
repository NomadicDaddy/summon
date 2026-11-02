import type { TerminalProcess } from './team.ts';

import { NotificationNotSentError } from '../notification-delivery.ts';

interface InputState {
	version: number;
	draft: boolean;
	/** When a lone human Escape last arrived, so a quick second one can be read as a pair. */
	escapeAt?: number;
}
const states = new WeakMap<TerminalProcess, InputState>();

/*
 * DOUBLE ESCAPE (card 1482402a). On the installed CLIs a single Escape leaves a typed draft in
 * place, and two Escapes clear it (Claude Code 2.1.293 empties the box; Grok 1.0.46 stashes the
 * text, which leaves the visible input empty and the draft recoverable by a human key, itself new
 * human input). Measured with real keys on 2026-10-07: both clear with the Escapes up to 750 ms
 * apart and neither at 1000 ms. The window here stays well inside that, because reading a pair
 * that the editor did not clear would let a notice glue onto the draft, while missing a pair only
 * waits for the next Enter, Ctrl+U or Ctrl+C. Only human keys count: an automatic protocol reply
 * can never be the second Escape. Evidence: shared/jimmy/draft-keys-20261007.md.
 */
export const DOUBLE_ESCAPE_MS = 500;
const ESCAPE = '\u001b';

export function terminalDraft(pty: TerminalProcess): Readonly<InputState> {
	return states.get(pty) ?? { version: 0, draft: false };
}

export function saveTerminalDraft(pty: TerminalProcess, version: number, draft: boolean): void {
	states.set(pty, { version, draft });
}

/**
 * Only a separate Enter confirms submission. Pasted text ending in CR is still a draft. With
 * `controlClears` (Claude and Grok, whose editors were measured), Ctrl+U, Ctrl+C and a quick
 * Escape pair clear too.
 */
export function recordTerminalDraft(
	pty: TerminalProcess,
	data: string,
	humanInput: boolean,
	controlClears = false,
	now = performance.now(),
): void {
	if (!data || !humanInput) return;
	const state = terminalDraft(pty);
	const escape = data === ESCAPE;
	// Monotonic time, and a negative interval is never a pair: a clock that moved must not turn a
	// later lone Escape into a clear (Morgan, ca4f0811).
	const elapsed = state.escapeAt === undefined ? -1 : now - state.escapeAt;
	const pair = escape && elapsed >= 0 && elapsed <= DOUBLE_ESCAPE_MS;
	const clears =
		data === '\r' || (controlClears && (['\u0003', '\u0015'].includes(data) || pair));
	states.set(pty, {
		version: state.version + 1,
		draft: !clears,
		// A lone Escape opens the pair window; anything else, including the pair itself, closes it.
		...(escape && !pair ? { escapeAt: now } : {}),
	});
}

export function assertTerminalDraftClear(pty: TerminalProcess): void {
	if (terminalDraft(pty).draft)
		throw new NotificationNotSentError('Terminal notice waits for the human input draft.');
}
