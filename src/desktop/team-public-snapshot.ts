import type { NotificationPauseView } from './notification-pause.ts';
import type { TeamSnapshot } from './types.ts';

import { publishLaunchStatus } from '../launch-status.ts';
import { operatorIdentity } from '../operator-identity.ts';
import { teamLabel } from '../store.ts';
import { teamSnapshot } from './team-snapshot.ts';

async function identityView(
	context: Parameters<typeof teamSnapshot>[0],
	snapshot: TeamSnapshot,
): Promise<Pick<TeamSnapshot, 'operator' | 'operatorError'>> {
	try {
		const operator = await operatorIdentity(snapshot.agents);
		context.reported.delete('operator-identity');
		return { operator };
	} catch (error: unknown) {
		const operatorError = `settings/operator-identity.json: ${error instanceof Error ? error.message : 'Identity unavailable.'}`;
		if (!context.reported.has('operator-identity')) {
			context.reported.add('operator-identity');
			context.emit({ type: 'error', source: 'operator-identity', message: operatorError });
		}
		return { operatorError };
	}
}

/** The window publishes its observed roster and verifies coverage against its own live children. */
export async function publicTeamSnapshot(
	context: Parameters<typeof teamSnapshot>[0],
	notificationPause?: NotificationPauseView,
): Promise<TeamSnapshot> {
	const sampledAt = Date.now();
	const team = teamLabel();
	const snapshot = await teamSnapshot(context);
	const value = {
		...(await identityView(context, snapshot)),
		...(notificationPause ? { notificationPause } : {}),
		...snapshot,
		...(team ? { team } : {}),
	};
	await publishLaunchStatus(
		value,
		sampledAt,
		context.reported,
		(message) => context.emit({ type: 'error', message, source: 'launch-status' }),
		[...context.sessions]
			.filter(([, session]) => session.agent.status === 'running')
			.map(([slug]) => slug),
	);
	return value;
}
