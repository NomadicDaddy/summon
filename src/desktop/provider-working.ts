import type { TeamAgent } from './types.ts';

/** The tooltip on a Busy that came from the provider's turn record rather than the teammate. */
export const PROVIDER_TURN_TITLE =
	'Busy: the provider reports a turn in progress, although the teammate has not said so';

/** The tooltip on the Ready a session shows when its provider's turn record doesn't settle it. */
export const PROVIDER_TURN_UNKNOWN_TITLE =
	"Ready, but the provider's turn record doesn't say whether a turn is running. Stop asks first.";

/**
 * Whether this session's Ready comes with a provider turn of 'unknown' (Morticia's Info on
 * remediation-20261022-roster-resting-during-live-turn): the label then claims neither Resting nor
 * Busy, and without a tooltip the operator can't tell why a teammate that rested reads Ready. Most
 * 'unknown' is a record that reads cleanly with an unsettled phase (an attach, an out-of-order or
 * ended turn); only provider-turn.ts's catch is a record that couldn't be read at all, so the
 * wording says the record doesn't settle it rather than that it can't be read.
 */
export function providerTurnUnknown(agent: TeamAgent): boolean {
	return (
		agent.status === 'running' &&
		agent.providerTurn === 'unknown' &&
		agent.activity !== 'busy' &&
		agent.activity !== 'needs-user'
	);
}

/**
 * Whether the provider's own turn record says this session is working when the teammate's status
 * does not (remediation-20261022-roster-resting-during-live-turn). On installed 0.31.3 a Claude
 * session that had confirmed rest and was then given a prompt read Resting in the row, the header
 * and the statusbar while its pane counted the turn. The snapshot sets providerTurn only for this
 * window's own session and its current launch, so an earlier launch's record cannot reach here.
 * Self-reported Busy and Needs you already say more, so they keep their wording.
 */
export function providerWorking(agent: TeamAgent): boolean {
	return (
		agent.status === 'running' &&
		agent.providerTurn === 'busy' &&
		agent.activity !== 'busy' &&
		agent.activity !== 'needs-user'
	);
}
