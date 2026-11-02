import type { Team } from './team.ts';

import { readActivity } from '../agent-activity.ts';
import { automaticNoticeSuppressed } from '../automatic-notice.ts';
import { headDownActive } from '../head-down-model.ts';
import { operatorViewing } from '../operator-view.ts';
import { dispatchSchedules } from '../schedules.ts';
import { terminalDraft } from './terminal-draft.ts';

export async function tickSchedules(team: Team): Promise<void> {
	await dispatchSchedules(
		async (owner) => {
			if (await operatorViewing(owner)) return 'operator-viewing';
			if (await headDownActive(owner)) return 'head-down';
			if (await automaticNoticeSuppressed(owner)) return 'owner-unavailable';
			if (team.closing) return 'window-closing';
			const session = team.sessions.get(owner);
			if (session?.agent.status !== 'running') return 'not-running-here';
			if (session.agent.provider === 'kilo' && terminalDraft(session.pty).draft)
				return 'owner-unavailable';
			const activity = await readActivity(owner);
			if (activity?.state === 'idle') return true;
			if (activity?.state === 'busy') return 'owner-busy';
			return activity?.state === 'needs-user' ? 'owner-needs-user' : 'activity-unknown';
		},
		// The unified receiver observes the durable scheduled mail for every provider.
		async () => {},
	);
}
