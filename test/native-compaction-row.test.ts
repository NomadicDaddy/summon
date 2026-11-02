import { expect, test } from 'bun:test';

import type { TeamAgent } from '../src/desktop/types.ts';

import {
	headerState,
	memberStateLabel,
	memberWorkingText,
} from '../src/desktop/member-identity.ts';
import { COMPACTION_TITLE } from '../src/desktop/native-compaction.ts';

const agent = (over: Partial<TeamAgent> = {}): TeamAgent => ({
	slug: 'probe',
	name: 'Probe',
	provider: 'claude',
	cwd: 'D:/work',
	status: 'running',
	ownedSession: true,
	activity: 'busy',
	workingOn: 'Reviewing the notice fix',
	...over,
});

test('native compaction labels both surfaces without replacing the saved task or attention', () => {
	for (const activity of ['idle', 'busy', 'needs-user'] as const) {
		const value = agent({ nativeCompacting: true, activity });
		expect(memberStateLabel(value)).toBe('Compacting…');
		expect(headerState(value, activity)).toEqual({
			className: 'busy',
			label: 'Compacting…',
			title: COMPACTION_TITLE,
		});
		expect(memberWorkingText(value)).toBe('Reviewing the notice fix');
		expect(value.activity).toBe(activity);
	}
	expect(memberStateLabel(agent({ activity: 'needs-user' }))).toBe('Needs you');
});

test('stale, non-owned, unavailable and other-provider flags never claim compaction', () => {
	for (const over of [
		{ status: 'stopped' },
		{ status: 'elsewhere' },
		{ ownedSession: false },
		{ observationUnavailable: true },
		{ provider: 'codex' },
		{ provider: 'grok' },
		{ provider: 'kilo' },
	] satisfies Partial<TeamAgent>[]) {
		const value = agent({ nativeCompacting: true, ...over });
		expect(memberStateLabel(value)).not.toBe('Compacting…');
		expect(headerState(value, value.activity).title).not.toBe(COMPACTION_TITLE);
	}
});
