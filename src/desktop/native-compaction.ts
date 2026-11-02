import type { TeamAgent } from './types.ts';

export const COMPACTION_TITLE = 'Claude reported that context compaction is in progress.';

/** An observation beside the saved task; neither activity nor silence can establish compaction. */
export function nativeCompacting(agent: TeamAgent | undefined): boolean {
	return (
		agent?.status === 'running' &&
		agent.ownedSession === true &&
		agent.observationUnavailable !== true &&
		agent.provider === 'claude' &&
		agent.nativeCompacting === true
	);
}
