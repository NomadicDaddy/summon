import type { Team } from './team.ts';

import { automaticInterruptionsPaused } from '../automatic-interruptions.ts';
import { communicationState } from '../communication-state.ts';
import { isHibernated } from '../hibernation.ts';
import { LockBusyError } from '../mail-files.ts';
import { sendMessage } from '../mailbox.ts';
import { processAlive } from '../process-owner.ts';
import { processRestStops } from '../rest-stop.ts';
import { claimRestWake, finishRestWake, refreshRest, stopForRest } from '../rest.ts';
import { listAgentSlugs } from '../store.ts';
import { nudgeRest } from './rest-nudge.ts';
import { stopRestSession } from './rest-stop.ts';
import { clearWakeError, reportWakeError } from './team-wake-errors.ts';

export async function tickRest(team: Team): Promise<void> {
	if (team.closing || (await communicationState()).paused) return;
	await processRestStops(
		async (name, confirmation) => {
			const session = team.sessions.get(name);
			if (session?.agent.status !== 'running')
				throw new Error(
					`${name}: session is not running in this Team Window. External sessions are not stopped.`,
				);
			await stopForRest(
				name,
				confirmation,
				(nonce) => stopRestSession(team, name, nonce),
				session.agent.provider,
			);
		},
		(error, name) => team.error(error, name),
	);
	const failures: unknown[] = [];
	for (const name of await listAgentSlugs()) {
		try {
			if (await tickRestOwner(team, name)) await clearWakeError(`${name} rest wake`, name);
		} catch (error: unknown) {
			// A concurrent ready/stop transaction is not a failed wake. The next tick retries.
			if (error instanceof LockBusyError) continue;
			try {
				await reportWakeError(team, `${name} rest wake`, error, name);
			} catch (persistError: unknown) {
				failures.push(persistError);
			}
		}
	}
	if (failures.length) throw new AggregateError(failures, 'Could not retain rest wake errors.');
}

async function tickRestOwner(team: Team, name: string): Promise<boolean> {
	if (await automaticInterruptionsPaused(name)) return false;
	if (await isHibernated(name)) return false;
	const state = await refreshRest(name);
	if (state?.mode === 'waking' && !processAlive(state.wakePid ?? 0)) {
		await finishRestWake(
			name,
			state.id,
			'Wake interrupted; inspect the session and resume manually.',
		);
		team.error(`${name}: interrupted rest wake requires inspection.`, name);
		return false;
	}
	if (state?.mode !== 'wake-requested') {
		if (!state || state.mode === 'awake') await nudgeRest(team, name);
		return false;
	}
	if (!state.resume && team.sessions.get(name)?.agent.status !== 'running') return false;
	const claimed = await claimRestWake(name, state.id);
	if (!claimed) return false;
	try {
		if (claimed.reason !== 'Activity is not idle' || claimed.resume) {
			if (claimed.resume) await team.start(name, false, 'rest-work');
			const session = team.sessions.get(name);
			if (session?.agent.status !== 'running')
				throw new Error(`${name}: session is not running in this Team Window.`);
			const message = `Rest ended: ${claimed.reason}. Run summon --checkpoint with your retained receipt and check your own cards and schedules. Work only within existing authority.`;
			await sendMessage(name, name, message, {
				id: claimed.id,
				system: {
					purpose: 'rest-ended',
					nonce: session.launch.nonce,
					confirmation: claimed.id,
					previousActivityNonce: session.previousActivityNonce ?? null,
				},
			});
		}
		await finishRestWake(name, claimed.id);
		return true;
	} catch (error: unknown) {
		await finishRestWake(
			name,
			claimed.id,
			'Wake failed; inspect the session and resume manually.',
		);
		await reportWakeError(team, `${name} rest wake`, error, name);
		return false;
	}
}
