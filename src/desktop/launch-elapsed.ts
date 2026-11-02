import type { TeamAgent } from './types.ts';

import { launchLabel } from './launch-phase-label.ts';

/*
 * How long a launch has been connecting (remediation-20261021-roster-shows-provider-first-run-prompt,
 * Phillip #19108). A provider stopped at a first-run question looks exactly like a slow start, so
 * nothing is guessed: Connecting stays the word, and once it has lasted long enough to be worth
 * saying, the time beside it says how long. The roster redraws only when its snapshot changes, and
 * a stuck launch changes nothing, so the count runs on its own ticker and the word's letter motion
 * is left alone.
 */

/** How long Connecting reads bare before the time beside it appears. */
export const CONNECTING_ELAPSED_AFTER_MS = 30_000;

/** "45s", "1m 20s" or "1h 05m" since a launch began connecting, or empty before the threshold. */
export function connectingElapsed(since: string | undefined, now: number): string {
	if (!since) return '';
	const ms = now - Date.parse(since);
	if (!Number.isFinite(ms) || ms < CONNECTING_ELAPSED_AFTER_MS) return '';
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** When to count from: only while the label actually shown is the connecting word. */
export function connectingSince(
	agent: Pick<TeamAgent, 'launch' | 'status'> | undefined,
	label: string,
): string | undefined {
	if (!agent?.launch || agent.launch.phase !== 'connecting') return undefined;
	return launchLabel(agent) === label ? agent.launch.since : undefined;
}

function paint(element: HTMLElement, now: number): void {
	const text = connectingElapsed(element.dataset['connectingSince'], now);
	element.textContent = text;
	element.hidden = text === '';
}

/** Point an elapsed-time element at a launch to count from, or clear it. */
export function markElapsed(
	element: HTMLElement,
	since: string | undefined,
	now = Date.now(),
): void {
	if (since) element.dataset['connectingSince'] = since;
	else delete element.dataset['connectingSince'];
	paint(element, now);
}

/** Recount every marked element once a second, without redrawing anything else. */
export function startElapsedTicker(root: ParentNode = document): void {
	setInterval(() => {
		const now = Date.now();
		for (const element of root.querySelectorAll<HTMLElement>('[data-connecting-since]'))
			paint(element, now);
	}, 1000);
}
