import type { Team } from './team.ts';
import type { StopResult } from './types.ts';

import { readActivity } from '../agent-activity.ts';
import { providerTurn } from '../provider-turn.ts';

/**
 * The main process's own look, when team:stop arrives, at whether this Stop must ask. The
 * renderer decides from its last snapshot, which is published at most every 2 s, so a turn that
 * began since then reads as idle there, and a Stop pressed right after a prompt ended live work
 * unasked on installed 0.31.3 (remediation-20261023-stop-decides-on-stale-snapshot). Same
 * evidence as stopNeedsConfirm, read now: the teammate's own busy or needs-user status for this
 * launch, or a provider turn that is busy or unreadable. Anything that can't be read asks.
 */
export async function stopNeedsConfirmNow(
	team: Pick<Team, 'sessions'>,
	slug: string,
): Promise<boolean> {
	const session = team.sessions.get(slug);
	if (session?.agent.status !== 'running') return false;
	try {
		const activity = await readActivity(slug);
		if (
			activity?.nonce === session.launch.nonce &&
			(activity.state === 'busy' || activity.state === 'needs-user')
		)
			return true;
		return (
			(await providerTurn(session.agent.provider, slug, session.launch.nonce)) !== undefined
		);
	} catch {
		return true;
	}
}

/** Stop unless the session needs a question the operator hasn't answered yet. */
export async function stopIfConfirmed(
	team: Pick<Team, 'sessions' | 'stop'>,
	slug: string,
	confirmed: boolean,
): Promise<StopResult> {
	if (!confirmed) {
		const session = team.sessions.get(slug);
		if ((await stopNeedsConfirmNow(team, slug)) || team.sessions.get(slug) !== session)
			return { needsConfirm: true };
	}
	const outcome = await team.stop(slug);
	return outcome.verified
		? { stopped: true }
		: { unverified: true, rootChecked: outcome.rootChecked, detail: outcome.detail };
}
