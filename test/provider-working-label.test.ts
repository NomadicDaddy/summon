import { expect, test } from 'bun:test';

import type { TeamAgent } from '../src/desktop/types.ts';
import type { LaunchPhaseView } from '../src/launch-phase-model.ts';

import { headerState, memberStateLabel, stateTone } from '../src/desktop/member-identity.ts';
import {
	PROVIDER_TURN_TITLE,
	PROVIDER_TURN_UNKNOWN_TITLE,
	providerTurnUnknown,
	providerWorking,
} from '../src/desktop/provider-working.ts';
import { offersRestStop } from '../src/desktop/rest-roster.ts';

/*
 * remediation-20261022-roster-resting-during-live-turn. On installed 0.31.3 a Claude teammate that
 * had confirmed rest and was then given a prompt read Resting in the roster row, the session header
 * and the statusbar while its own turn record said busy and its pane counted the turn. One label
 * feeds all three, so these tests hold that label and the header's class and tooltip. Against the
 * old memberStateLabel the first test fails: it read Resting throughout.
 */
/** A running teammate that has not confirmed rest. */
const awake = (over: Partial<TeamAgent> = {}): TeamAgent => ({
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
/** The same teammate after it confirmed rest. */
const agent = (over: Partial<TeamAgent> = {}): TeamAgent =>
	awake({ restConfirmation: 'rest-1', ...over });

test('a resting session reads Busy while its provider turn runs, and Resting again after', () => {
	const resting = agent();
	expect(memberStateLabel(resting)).toBe('Resting');
	const turning = agent({ providerTurn: 'busy' });
	expect(memberStateLabel(turning)).toBe('Busy');
	expect(stateTone(memberStateLabel(turning))).toBe('busy');
	const header = headerState(turning, turning.activity);
	expect(header.label).toBe('Busy');
	expect(header.className).toBe('busy');
	expect(header.title).toBe(PROVIDER_TURN_TITLE);
	// The snapshot drops providerTurn once the turn is idle again.
	expect(memberStateLabel(agent())).toBe('Resting');
	expect(headerState(agent(), 'idle')).toEqual({
		className: 'running',
		label: 'Resting',
		title: '',
	});
});

test('a session that has not rested reads Busy, not Ready, while the provider works', () => {
	expect(memberStateLabel(awake({ providerTurn: 'busy' }))).toBe('Busy');
});

test('an unknown provider turn claims neither Resting nor Busy, and says why', () => {
	const unknown = agent({ providerTurn: 'unknown' });
	expect(providerWorking(unknown)).toBe(false);
	expect(providerTurnUnknown(unknown)).toBe(true);
	expect(memberStateLabel(unknown)).toBe('Ready');
	// The header's title also reaches the statusbar (renderer.ts).
	expect(headerState(unknown, 'idle')).toEqual({
		className: 'running',
		label: 'Ready',
		title: PROVIDER_TURN_UNKNOWN_TITLE,
	});
	// The teammate's own Busy or Needs you says more, so the unknown-turn note stays off.
	expect(providerTurnUnknown(agent({ activity: 'busy', providerTurn: 'unknown' }))).toBe(false);
	expect(providerTurnUnknown(agent({ activity: 'needs-user', providerTurn: 'unknown' }))).toBe(
		false,
	);
	expect(providerTurnUnknown(agent({ providerTurn: 'unknown', status: 'elsewhere' }))).toBe(
		false,
	);
});

test("the teammate's own Busy and Needs you keep their wording and their tooltip", () => {
	const busy = agent({ activity: 'busy', providerTurn: 'busy' });
	expect(providerWorking(busy)).toBe(false);
	expect(memberStateLabel(busy)).toBe('Busy');
	expect(headerState(busy, 'busy').title).toBe('');
	const asking = agent({ activity: 'needs-user', providerTurn: 'busy' });
	expect(providerWorking(asking)).toBe(false);
	expect(memberStateLabel(asking)).toBe('Needs you');
});

test('only a running session of this window can be working on the provider record', () => {
	for (const status of ['elsewhere', 'stopped', 'exited', 'offline'] as const)
		expect(providerWorking(agent({ providerTurn: 'busy', status }))).toBe(false);
});

test('Busy from the provider outranks a launch phase, in the label and the header', () => {
	const launch: LaunchPhaseView = {
		evidence: 'owned-process-spawn',
		phase: 'connecting',
		since: '2026-10-23T07:00:00.000Z',
	};
	const working = awake({ launch, providerTurn: 'busy' });
	expect(memberStateLabel(working)).toBe('Busy');
	expect(headerState(working, 'idle')).toEqual({
		className: 'busy',
		label: 'Busy',
		title: PROVIDER_TURN_TITLE,
	});
});

test('an unavailable or compacting session keeps its own word over a provider turn', () => {
	expect(
		memberStateLabel(agent({ observationUnavailable: true, providerTurn: 'busy' })),
	).not.toBe('Busy');
	expect(memberStateLabel(agent({ nativeCompacting: true, providerTurn: 'busy' }))).toBe(
		'Compacting…',
	);
});

test('the Zzz rest-stop is offered only while no provider turn is on record', () => {
	expect(offersRestStop(agent())).toBe(true);
	// It stops without the ordinary Stop question, so it is withdrawn during a turn or an
	// unreadable one; the main-process rest-stop guard is separate work.
	expect(offersRestStop(agent({ providerTurn: 'busy' }))).toBe(false);
	expect(offersRestStop(agent({ providerTurn: 'unknown' }))).toBe(false);
	expect(offersRestStop(awake())).toBe(false);
	expect(offersRestStop(agent({ status: 'elsewhere' }))).toBe(false);
});
