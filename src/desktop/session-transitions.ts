import { resolve } from 'node:path';

import type { OwnedLaunch } from '../launch-phase-model.ts';
import type { SessionTransitionInput } from '../session-history.ts';
import type { TeamAgent } from './types.ts';

import { appendSessionTransition } from '../session-history.ts';
import { storageRoot } from '../store.ts';

type SessionEvidence = {
	agent: TeamAgent;
	launch: OwnedLaunch;
	pty: { pid: number };
	previousLaunchNonce?: string;
	stopRequested?: boolean;
	stopReason?: SessionTransitionInput['reason'];
	stopUnverified?: unknown;
};

/** Keep event order and root identity across asynchronous persistence, including exit callbacks. */
export function sessionTransitions(windowStartedAt: string, report: () => void) {
	const root = resolve(storageRoot());
	let pending: Promise<void> = Promise.resolve();
	let failed = false;
	const record = (input: SessionTransitionInput): Promise<void> => {
		const observedAt = new Date().toISOString();
		pending = pending.then(async () => {
			try {
				await appendSessionTransition(input, windowStartedAt, root, observedAt);
				failed = false;
			} catch {
				if (!failed) report();
				failed = true;
			}
		});
		return pending;
	};
	const recordSession = (
		session: SessionEvidence,
		state: SessionTransitionInput['state'],
		reason: SessionTransitionInput['reason'],
		exitCode?: number,
	): Promise<void> =>
		record({
			member: session.agent.slug,
			provider: session.agent.provider,
			nonce: session.launch.nonce,
			pid: session.pty.pid,
			state,
			reason,
			...(session.previousLaunchNonce ? { previousNonce: session.previousLaunchNonce } : {}),
			...(exitCode === undefined ? {} : { exitCode }),
		});
	return {
		recordSession,
		ended: (session: SessionEvidence, exitCode?: number): Promise<void> => {
			session.agent.status = session.stopRequested ? 'stopped' : 'exited';
			if (exitCode !== undefined) session.agent.exitCode = exitCode;
			// The terminal's own exit settles an unverified stop.
			delete session.stopUnverified;
			delete session.agent.stopUnverified;
			return recordSession(
				session,
				session.stopRequested ? 'stopped' : 'exited',
				session.stopReason ?? 'unknown',
				exitCode,
			);
		},
		flush: async (): Promise<void> => {
			for (;;) {
				const current = pending;
				await current;
				if (pending === current) return;
			}
		},
	};
}
