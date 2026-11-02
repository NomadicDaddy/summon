import type { TerminalProcess } from './team.ts';

/**
 * The launch nonce the Window's receiver captured for each owned Claude pane. Human input spends a
 * withheld-Enter release token for this launch, so it never depends on re-reading activity.json,
 * which can be missing or briefly unreadable. A later receiver for the same pane overwrites it; an
 * older entry is never removed, because spending a stale launch's token is always safe.
 */
const launches = new WeakMap<TerminalProcess, string>();

export function captureReceiverLaunch(pty: TerminalProcess, nonce: string): void {
	launches.set(pty, nonce);
}

export function receiverLaunch(pty: TerminalProcess): string | undefined {
	return launches.get(pty);
}
