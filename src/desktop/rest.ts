import type { RestScanCache } from '../rest.ts';
import type { Team } from './team.ts';

import { automaticInterruptionsPaused } from '../automatic-interruptions.ts';
import { communicationState } from '../communication-state.ts';
import { isHibernated } from '../hibernation.ts';
import { LockBusyError } from '../mail-files.ts';
import { sendMessage } from '../mailbox.ts';
import { processAlive } from '../process-owner.ts';
import { processRestStops } from '../rest-stop.ts';
import { claimRestWake, finishRestWake, readRest, refreshRest, stopForRest } from '../rest.ts';
import { listAgentSlugs } from '../store.ts';
import { nudgeRest } from './rest-nudge.ts';
import { stopRestSession } from './rest-stop.ts';
import { clearWakeError, reportWakeError } from './team-wake-errors.ts';

export interface RestScanDiagnostic {
	stopRequestsMs: number;
	listOwnersMs: number;
	ownerCount: number;
	otherOwnersMs: number;
	slowestOwners: {
		name: string;
		durationMs: number;
		wakeMs: number;
		cacheMs: number;
		errorMs: number;
		outcome: 'woken' | 'unchanged' | 'lock-busy' | 'failed';
	}[];
}

/** Bounded, content-free timings for the existing mention-scan diagnostic. */
export async function tickRest(
	team: Team,
	cache?: RestScanCache,
	onDiagnostic?: (diagnostic: RestScanDiagnostic) => void,
): Promise<void> {
	if (team.closing || (await communicationState()).paused) return;
	const diagnostic: RestScanDiagnostic = {
		stopRequestsMs: 0,
		listOwnersMs: 0,
		ownerCount: 0,
		otherOwnersMs: 0,
		slowestOwners: [],
	};
	const owners: RestScanDiagnostic['slowestOwners'] = [];
	try {
		const stopStarted = performance.now();
		try {
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
		} finally {
			diagnostic.stopRequestsMs = Math.round(performance.now() - stopStarted);
		}
		const failures: unknown[] = [];
		const listStarted = performance.now();
		const names = await listAgentSlugs();
		diagnostic.listOwnersMs = Math.round(performance.now() - listStarted);
		diagnostic.ownerCount = names.length;
		for (const name of names) {
			const ownerStarted = performance.now();
			let wakeMs = 0;
			let cacheMs = 0;
			let errorMs = 0;
			let outcome: (typeof owners)[number]['outcome'] = 'unchanged';
			try {
				const wakeStarted = performance.now();
				try {
					if (await tickRestOwner(team, name)) {
						outcome = 'woken';
						await clearWakeError(`${name} rest wake`, name);
					}
				} finally {
					wakeMs = Math.round(performance.now() - wakeStarted);
				}
				const cacheStarted = performance.now();
				try {
					cache?.set(name, await readRest(name));
				} finally {
					cacheMs = Math.round(performance.now() - cacheStarted);
				}
			} catch (error: unknown) {
				// A concurrent ready/stop transaction is not a failed wake. The next tick retries.
				if (error instanceof LockBusyError) outcome = 'lock-busy';
				else {
					outcome = 'failed';
					const errorStarted = performance.now();
					try {
						await reportWakeError(team, `${name} rest wake`, error, name);
					} catch (persistError: unknown) {
						failures.push(persistError);
					} finally {
						errorMs = Math.round(performance.now() - errorStarted);
					}
				}
			} finally {
				owners.push({
					name,
					durationMs: Math.round(performance.now() - ownerStarted),
					wakeMs,
					cacheMs,
					errorMs,
					outcome,
				});
			}
		}
		if (failures.length)
			throw new AggregateError(failures, 'Could not retain rest wake errors.');
	} finally {
		owners.sort(
			(left, right) =>
				right.durationMs - left.durationMs || left.name.localeCompare(right.name),
		);
		diagnostic.slowestOwners = owners.slice(0, 8);
		diagnostic.otherOwnersMs = owners
			.slice(8)
			.reduce((sum, owner) => sum + owner.durationMs, 0);
		try {
			onDiagnostic?.(diagnostic);
		} catch (error: unknown) {
			team.error(error);
		}
	}
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
