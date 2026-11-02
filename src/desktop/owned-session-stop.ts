import type { SessionTransitionInput } from '../session-history.ts';
import type { killProcessTree } from './pty-process.ts';
import type { sessionTransitions } from './session-transitions.ts';
import type { Team } from './team.ts';

import { tryGracefulStop } from './graceful-stop.ts';
import { ProcessTreeStopError } from './pty-process.ts';

export type { StopRoot } from './stop-root.ts';

/** A stop either ended the session, or termination was attempted once and is still unverified. */
export type StopOutcome =
	{ verified: true } | { verified: false; rootChecked: boolean; detail: string };
export type StopReason = SessionTransitionInput['reason'];

/** The stop state an owned session carries, kept beside the code that sets it. */
export interface SessionStop {
	stopRequested?: boolean;
	stopReason?: StopReason;
	/** Taskkill reported a failure after Stop; cleared by the terminal's own exit. */
	stopUnverified?: { rootChecked: boolean; detail: string };
	/** The root's creation time, captured at launch so a reused PID is never taken for it. */
	rootStartedAt?: Promise<number | undefined>;
}

/**
 * Read the root's identity at launch; the reader keeps it only for this exact launch nonce. A Team
 * without a reader (tests that do not exercise it) captures nothing, so its roots read unknown.
 */
export async function captureRoot(
	team: Pick<Team, 'stopRoot'>,
	pid: number,
	slug: string,
	launch: { nonce: string; since: string },
): Promise<number | undefined> {
	const root = { slug, nonce: launch.nonce, since: Date.parse(launch.since) };
	return team.stopRoot?.capture(pid, root).catch(() => undefined);
}

/** For callers whose contract is "stopped or failed": an unverified stop is not stopped. */
export async function requireVerified(stop: Promise<StopOutcome>): Promise<void> {
	const outcome = await stop;
	if (!outcome.verified) throw new Error(outcome.detail);
}

export async function stopOwnedSession(
	team: Team,
	slug: string,
	reason: StopReason,
	history: ReturnType<typeof sessionTransitions>,
	terminate: typeof killProcessTree,
	ended: (session: NonNullable<ReturnType<Team['sessions']['get']>>) => void,
): Promise<StopOutcome> {
	const session = team.sessions.get(slug);
	if (session?.agent.status !== 'running') return { verified: true };
	// One termination attempt per Stop: a second Stop while unverified reports the same state
	// instead of running taskkill again on a PID the operating system may have reused.
	if (session.stopUnverified) return { verified: false, ...session.stopUnverified };
	const running = (): boolean =>
		team.sessions.get(slug) === session && session.agent.status === 'running';
	session.stopRequested = true;
	session.stopReason = reason;
	await history.recordSession(session, 'stop-requested', reason);
	try {
		await tryGracefulStop(session, () => team.sessions.get(slug) === session);
		if (!running()) return { verified: true };
		if (process.platform === 'win32') {
			await terminate(session.pty.pid, () => session.agent.status !== 'running');
			// ConPTY may delay its callback after confirmed process-tree termination.
			ended(session);
		} else session.pty.kill();
		return { verified: true };
	} catch (error) {
		// Taskkill ran and reported a failure. Its descendants may be gone, going, or beyond reach,
		// and ConPTY can report the exit minutes later (bsa1, 2026-10-28: about 117 s). Keep the
		// operator's intent so that exit is recorded as stopped, and attempt nothing further.
		if (error instanceof ProcessTreeStopError && running())
			return unverified(team, session, reason, history, error, running);
		session.stopRequested = false;
		delete session.stopReason;
		await history.recordSession(session, 'stop-failed', reason);
		throw error;
	}
}

async function unverified(
	team: Team,
	session: NonNullable<ReturnType<Team['sessions']['get']>>,
	reason: StopReason,
	history: ReturnType<typeof sessionTransitions>,
	error: ProcessTreeStopError,
	running: () => boolean,
): Promise<StopOutcome> {
	const startedAt = await session.rootStartedAt;
	const root =
		(await team.stopRoot?.state(error.pid, startedAt).catch(() => 'unknown' as const)) ??
		'unknown';
	// The exit may have arrived while the root was being read; ended() then recorded it.
	if (!running()) return { verified: true };
	const detail = `${session.agent.slug}: Stop unverified; waiting for terminal exit. Taskkill exit ${error.code ?? error.signal ?? 'unknown'} for PID ${error.pid}; root process ${root}. ${error.output.trim() || 'No diagnostic output.'}`;
	const state = { rootChecked: root !== 'unknown', detail };
	session.stopUnverified = state;
	session.agent.stopUnverified = true;
	// Only a root confirmed alive means termination did not take effect; otherwise the latest
	// history record stays stop-requested until the exit writes stopped.
	if (root === 'alive') await history.recordSession(session, 'stop-failed', reason);
	await team.publish();
	// The exit can also land during either write above; ended() has then cleared the mark, so the
	// operator gets the verified answer the terminal has given.
	return running() ? { verified: false, ...state } : { verified: true };
}
