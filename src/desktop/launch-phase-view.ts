import type { AgentActivity } from '../agent-activity.ts';
import type { LaunchPhaseView, OwnedLaunch } from '../launch-phase-model.ts';
import type { Team } from './team.ts';

import { readActivity } from '../agent-activity.ts';
import { launchPhaseView } from '../launch-phase-model.ts';

export function ownedLaunchView(
	launch: OwnedLaunch,
	activity: AgentActivity | undefined,
): LaunchPhaseView | undefined {
	if (activity?.nonce !== launch.nonce)
		return { phase: 'connecting', since: launch.since, evidence: 'owned-process-spawn' };
	return activity.launch ? launchPhaseView(activity.launch) : undefined;
}

/** Retain the phase only while this same child is still the window's exited generation. */
export async function retainEndedLaunch(
	team: Team,
	name: string,
	session: NonNullable<ReturnType<Team['sessions']['get']>>,
): Promise<void> {
	const phase = ownedLaunchView(session.launch, await readActivity(name));
	if (!phase || team.sessions.get(name) !== session || session.agent.status !== 'exited') return;
	session.agent.launchEnded = phase;
	team.error(
		`Session ended during ${phase.phase} before reporting its first status.`,
		name,
		'launch',
	);
	await team.publish();
}
