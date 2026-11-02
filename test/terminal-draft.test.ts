import { expect, test } from 'bun:test';

import type { TerminalProcess } from '../src/desktop/team.ts';

import {
	DOUBLE_ESCAPE_MS,
	recordTerminalDraft,
	terminalDraft,
} from '../src/desktop/terminal-draft.ts';

/*
 * The draft recorder's clear rules (card 1482402a), as measured on the installed Claude and Grok
 * CLIs on 2026-10-07: a single Escape leaves the draft, a quick Escape pair clears it, Ctrl+U and
 * Ctrl+C clear it, Enter submits. Each test names the wrong answer it guards against.
 */
function pty(): TerminalProcess {
	return {
		pid: process.pid,
		onData: () => ({ dispose: () => {} }),
		onExit: () => ({ dispose: () => {} }),
		write: () => {},
		resize: () => {},
		kill: () => {},
	};
}
const ESC = '\u001b';

test('a single Escape never clears a draft, however long the human waits', () => {
	const t = pty();
	recordTerminalDraft(t, 'd', true, true, 1000);
	recordTerminalDraft(t, ESC, true, true, 2000);
	expect(terminalDraft(t).draft).toBe(true);
	recordTerminalDraft(t, ESC, true, true, 2000 + DOUBLE_ESCAPE_MS + 1);
	expect(terminalDraft(t).draft).toBe(true);
});

test('a quick Escape pair clears the draft for a measured provider', () => {
	const t = pty();
	recordTerminalDraft(t, 'd', true, true, 1000);
	recordTerminalDraft(t, ESC, true, true, 2000);
	recordTerminalDraft(t, ESC, true, true, 2000 + DOUBLE_ESCAPE_MS);
	expect(terminalDraft(t).draft).toBe(false);
	// The pair is spent: a third Escape on its own is a lone Escape again.
	recordTerminalDraft(t, 'x', true, true, 3000);
	recordTerminalDraft(t, ESC, true, true, 3100);
	expect(terminalDraft(t).draft).toBe(true);
});

test('a clock that moved backwards cannot make a lone Escape look like a pair', () => {
	const t = pty();
	recordTerminalDraft(t, 'd', true, true, 5000);
	recordTerminalDraft(t, ESC, true, true, 6000);
	recordTerminalDraft(t, ESC, true, true, 5900);
	expect(terminalDraft(t).draft).toBe(true);
	// The second Escape reopened the window at its own time; a third within it is a pair.
	recordTerminalDraft(t, ESC, true, true, 5900 + DOUBLE_ESCAPE_MS);
	expect(terminalDraft(t).draft).toBe(false);
});

test('typing between the two Escapes keeps the draft', () => {
	const t = pty();
	recordTerminalDraft(t, ESC, true, true, 1000);
	recordTerminalDraft(t, 'x', true, true, 1100);
	recordTerminalDraft(t, ESC, true, true, 1200);
	expect(terminalDraft(t).draft).toBe(true);
});

test('an automatic reply can never be the second Escape', () => {
	const t = pty();
	recordTerminalDraft(t, 'd', true, true, 1000);
	recordTerminalDraft(t, ESC, true, true, 2000);
	recordTerminalDraft(t, ESC, false, true, 2100);
	expect(terminalDraft(t).draft).toBe(true);
	// And an Escape-led protocol reply is not a lone Escape.
	recordTerminalDraft(t, `${ESC}[?1;2c`, true, true, 2200);
	recordTerminalDraft(t, ESC, true, true, 2300);
	expect(terminalDraft(t).draft).toBe(true);
});

test('providers without measured control clears keep only Enter', () => {
	const t = pty();
	recordTerminalDraft(t, 'd', true, false, 1000);
	recordTerminalDraft(t, ESC, true, false, 2000);
	recordTerminalDraft(t, ESC, true, false, 2100);
	expect(terminalDraft(t).draft).toBe(true);
	recordTerminalDraft(t, '\u0015', true, false, 2200);
	expect(terminalDraft(t).draft).toBe(true);
	recordTerminalDraft(t, '\r', true, false, 2300);
	expect(terminalDraft(t).draft).toBe(false);
});

test('restoring a Grok stash (Ctrl+Z) or yanking killed text (Ctrl+Y) is a draft again', () => {
	// Measured 2026-10-07: Ctrl+Z brings the stashed text back; Ctrl+Y yanks what Ctrl+U killed.
	const t = pty();
	recordTerminalDraft(t, 'd', true, true, 1000);
	recordTerminalDraft(t, ESC, true, true, 2000);
	recordTerminalDraft(t, ESC, true, true, 2100);
	expect(terminalDraft(t).draft).toBe(false);
	recordTerminalDraft(t, '\u001a', true, true, 3000);
	expect(terminalDraft(t).draft).toBe(true);
	recordTerminalDraft(t, '\u0015', true, true, 4000);
	expect(terminalDraft(t).draft).toBe(false);
	recordTerminalDraft(t, '\u0019', true, true, 5000);
	expect(terminalDraft(t).draft).toBe(true);
});

test('Ctrl+U, Ctrl+C and Enter still clear, and a paste ending in CR is still a draft', () => {
	const t = pty();
	for (const key of ['\u0015', '\u0003', '\r']) {
		recordTerminalDraft(t, 'd', true, true, 1000);
		recordTerminalDraft(t, key, true, true, 1100);
		expect(terminalDraft(t).draft).toBe(false);
	}
	recordTerminalDraft(t, 'pasted\r', true, true, 1200);
	expect(terminalDraft(t).draft).toBe(true);
	expect(terminalDraft(t).version).toBe(7);
});
