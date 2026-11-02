import type { RuntimeFaultInput } from './types.ts';

import { readableError } from './ipc-error.ts';

/**
 * Keep what the window just told the operator went wrong.
 *
 * Every error and warning this window shows is drawn into a slot that the next action, the next
 * poll or the next dismiss wipes, so the only durable record of a bad afternoon was the operator's
 * own screen (#6837). Each slot now hands its exact on-screen text to the fault journal through the
 * bridge, with the call site that showed it and, where the surface is about one teammate, that
 * teammate. Main-process events already arrive retained (`diagnosticHandled`) and are not sent
 * again from here; redisplaying a fault the roster is still holding is not sent either.
 *
 * Reporting is fire-and-forget: a surface that is already failing must not fail a second time
 * because the journal did. An unconfirmed write is not silent, though. The first rejection of an
 * episode dispatches `runtime-fault-write-failed` on the window and shows the fixed notice beside
 * the error box; the episode ends with the next confirmed write, which hides it again. The notice
 * says "could not be confirmed" rather than "not saved", because a rejected I/O call can have
 * landed anyway. The notice is never itself reported, or a dead journal would loop on its own
 * obituary.
 */
/**
 * The main process reports its own unconfirmed journal writes as an error event under this source
 * (`diagnosticHandled`, so it is not re-reported). It opens the same episode a rejected
 * `faultReport` does, and the ordinary error that follows may replace the banner text but never
 * clears the notice: only a confirmed write does - from either side. A main event that arrives
 * with `diagnosticSaved: true` is a confirmed write too, so an episode opened by a main-only
 * failure closes on the next saved main record without the renderer having to write anything
 * (Roger's finding on dbdec4f: it previously stayed open until a renderer write happened by).
 */
export const PERSISTENCE_SOURCE = 'runtime-fault.persistence';

let failing = false;

function notice(): HTMLElement | null {
	return document.getElementById('fault-notice');
}

/**
 * The reason the operator saw, without the transport wrapper, bounded. Line breaks are kept: the
 * journal keeps only the first line, and flattening here would hand it a stack or payload tail as
 * part of that line.
 */
export function faultText(error: unknown): string {
	return readableError(error).trim().slice(0, 8192);
}

/** A write the journal did not confirm: first one of an episode shows the notice and says so. */
export function noteUnconfirmedWrite(source: string): void {
	if (failing) return;
	failing = true;
	const node = notice();
	if (node) node.hidden = false;
	window.dispatchEvent(new CustomEvent('runtime-fault-write-failed', { detail: { source } }));
}

/** A write the journal confirmed, from this window or from the main process: the episode ends. */
export function noteConfirmedWrite(): void {
	if (!failing) return;
	failing = false;
	const node = notice();
	if (node) node.hidden = true;
}

export function reportFault(entry: RuntimeFaultInput): void {
	// Bounded here as well as in faultText, so a long fixed sentence or warning line is kept as
	// a bounded record rather than refused by the bridge's validator.
	void window.team
		.faultReport({ ...entry, text: entry.text.slice(0, 8192) })
		.then(noteConfirmedWrite, () => noteUnconfirmedWrite(entry.source));
}
