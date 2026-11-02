import type { Team } from './team.ts';

import { assertRestStopTurn, RestStopRefusedError } from '../rest-turn.ts';
import { requireVerified } from './owned-session-stop.ts';

/** Recheck the exact owned launch after the consent transaction's asynchronous reads. */
export async function stopRestSession(
	team: Pick<Team, 'sessions' | 'stop'>,
	slug: string,
	nonce: string,
): Promise<void> {
	const session = team.sessions.get(slug);
	const current = (): boolean =>
		!!session &&
		team.sessions.get(slug) === session &&
		session.agent.status === 'running' &&
		!session.stopRequested &&
		session.launch.nonce === nonce;
	if (!session || !current())
		throw new RestStopRefusedError(`${slug}: owned launch changed; refresh the roster.`);
	await assertRestStopTurn(session.agent.provider, slug, nonce);
	if (!current())
		throw new RestStopRefusedError(`${slug}: owned launch changed; refresh the roster.`);
	// No await between this identity check and Team.stop setting stopRequested. Owned terminal
	// input then refuses further writes. Provider observation lag remains an explicit limit.
	// An unverified stop is not a stopped rest: stopForRest records it as uncertain, as before.
	await requireVerified(team.stop(slug, 'rest-work'));
}
