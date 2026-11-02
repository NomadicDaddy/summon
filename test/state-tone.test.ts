import { expect, test } from 'bun:test';

import type { TeamAgent } from '../src/desktop/types.ts';
import type { LaunchPhaseView } from '../src/launch-phase-model.ts';

import { memberStateLabel, stateTone } from '../src/desktop/member-identity.ts';

/*
 * Which state words take their dot's colour (Phillip #8525, #8530): Ready green, Busy amber, and
 * nothing else. The colours themselves are CSS and are verified in the built window (summon has
 * no DOM in bun:test); what is held here is that only those two words are ever marked.
 */
const agent = (over: Partial<TeamAgent> = {}): TeamAgent => ({
	activity: 'idle',
	cwd: 'D:/work',
	name: 'Probe',
	ownedSession: true,
	provider: 'claude',
	slug: 'probe',
	status: 'running',
	workingOn: '',
	...over,
});
const tone = (over: Partial<TeamAgent> = {}): ReturnType<typeof stateTone> =>
	stateTone(memberStateLabel(agent(over)));

test('a running idle session is Ready in green and a working one Busy in amber', () => {
	expect(tone()).toBe('ready');
	expect(tone({ activity: 'busy' })).toBe('busy');
	// A session running in another window that says it is busy has the amber dot too.
	expect(tone({ activity: 'busy', status: 'elsewhere' })).toBe('busy');
});

test('an idle session that confirmed rest reads Resting everywhere, and only an idle one', () => {
	// One label feeds the row, the session header and the statusbar (agent-activity clause 7).
	expect(memberStateLabel(agent({ restConfirmation: 'r' }))).toBe('Resting');
	expect(tone({ restConfirmation: 'r' })).toBeUndefined();
	expect(memberStateLabel(agent({ activity: 'busy', restConfirmation: 'r' }))).toBe('Busy');
	expect(memberStateLabel(agent({ activity: 'needs-user', restConfirmation: 'r' }))).toBe(
		'Needs you',
	);
	expect(memberStateLabel(agent({ restConfirmation: 'r', status: 'offline' }))).toBe(
		'Not running',
	);
});

test('every other state word stays neutral', () => {
	const launch: LaunchPhaseView = {
		evidence: 'owned-process-spawn',
		phase: 'connecting',
		since: '2026-10-10T23:00:00.000Z',
	};
	for (const over of [
		{ activity: 'needs-user' },
		{ nativeCompacting: true },
		{ activity: 'busy', nativeCompacting: true },
		{ launch },
		{ observationUnavailable: true },
		{ status: 'elsewhere' },
		{ status: 'offline' },
		{ status: 'stopped' },
		{ status: 'hibernated' },
		{ status: 'exited' },
	] satisfies Partial<TeamAgent>[]) {
		expect(tone(over)).toBeUndefined();
	}
	expect(stateTone('')).toBeUndefined();
});
