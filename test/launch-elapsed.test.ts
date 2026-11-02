import { expect, test } from 'bun:test';

import type { TeamAgent } from '../src/desktop/types.ts';

import {
	CONNECTING_ELAPSED_AFTER_MS,
	connectingElapsed,
	connectingSince,
	markElapsed,
} from '../src/desktop/launch-elapsed.ts';
import { CONNECTING_HINT, launchTooltip } from '../src/desktop/launch-phase-label.ts';
import { memberStateLabel } from '../src/desktop/member-identity.ts';

/*
 * remediation-20261021-roster-shows-provider-first-run-prompt, Phillip's choice #19108: a launch
 * stuck at a provider's first-run question looks like a slow start, so Connecting stays the word,
 * the time beside it says how long once that is worth saying, and the tooltip says where to look.
 */
const since = '2026-10-22T12:00:00.000Z';
const start = Date.parse(since);
const connecting: TeamAgent = {
	slug: 'alpha',
	name: 'Alpha',
	provider: 'claude',
	cwd: '.',
	status: 'running',
	launch: { phase: 'connecting', since, evidence: 'owned-process-spawn' },
};

test('the time appears only after thirty seconds, then counts in plain units', () => {
	expect(connectingElapsed(since, start + CONNECTING_ELAPSED_AFTER_MS - 1)).toBe('');
	expect(connectingElapsed(since, start + 30_000)).toBe('30s');
	expect(connectingElapsed(since, start + 80_000)).toBe('1m 20s');
	expect(connectingElapsed(since, start + 9 * 60_000 + 5_000)).toBe('9m 05s');
	expect(connectingElapsed(since, start + 65 * 60_000)).toBe('1h 05m');
	expect(connectingElapsed(undefined, start + 80_000)).toBe('');
	expect(connectingElapsed('not a time', start + 80_000)).toBe('');
});

test('it counts only while the label shown is the connecting word', () => {
	expect(connectingSince(connecting, memberStateLabel(connecting))).toBe(since);
	// Busy and Needs you are things the teammate said, and they win over the phase.
	const busy = { ...connecting, activity: 'busy' as const };
	expect(connectingSince(busy, memberStateLabel(busy))).toBeUndefined();
	const loggingIn = {
		...connecting,
		launch: {
			phase: 'logging-in' as const,
			since,
			evidence: 'claude-mcp-initialized' as const,
		},
	};
	expect(connectingSince(loggingIn, memberStateLabel(loggingIn))).toBeUndefined();
	const stopped = { ...connecting, status: 'stopped' as const };
	expect(connectingSince(stopped, memberStateLabel(stopped))).toBeUndefined();
	expect(connectingSince(undefined, '')).toBeUndefined();
});

test('the tooltip says where to look while connecting, and claims nothing', () => {
	const tooltip = launchTooltip({ phase: 'connecting', since, evidence: 'owned-process-spawn' });
	expect(tooltip).toContain(CONNECTING_HINT);
	expect(CONNECTING_HINT).not.toMatch(/needs you|waiting for you|trust/i);
	expect(launchTooltip({ phase: 'startup', since, evidence: 'mail-readiness' })).not.toContain(
		CONNECTING_HINT,
	);
});

test('a marked element shows the count and hides when there is nothing to say', () => {
	const element = { dataset: {} as DOMStringMap, hidden: false, textContent: '' };
	const target = element as unknown as HTMLElement;
	markElapsed(target, since, start + 80_000);
	expect(element).toMatchObject({ hidden: false, textContent: '1m 20s' });
	expect(element.dataset['connectingSince']).toBe(since);
	markElapsed(target, since, start + 5_000);
	expect(element).toMatchObject({ hidden: true, textContent: '' });
	markElapsed(target, undefined, start + 80_000);
	expect(element.dataset['connectingSince']).toBeUndefined();
	expect(element).toMatchObject({ hidden: true, textContent: '' });
});
