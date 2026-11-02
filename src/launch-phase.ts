import { join } from 'node:path';

import type { AgentActivity } from './agent-activity.ts';
import type { LaunchPhase } from './launch-phase-model.ts';
import type { ModelInfo } from './model-info.ts';
import type { Provider } from './store.ts';

import { readActivity } from './agent-activity.ts';
import { atomicWrite, locked } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { runtimePath } from './mail-session.ts';

const ranks = { connecting: 0, 'logging-in': 1, startup: 2 };

/** A display observation must not prevent binding, readiness or the provider's startup turn. */
export async function observeLaunch(work: Promise<unknown>): Promise<void> {
	try {
		await work;
	} catch {
		console.error('Launch phase update could not be saved; startup transport continues.');
	}
}

async function update(
	name: string,
	nonce: string,
	change: (activity: AgentActivity, phase: LaunchPhase) => LaunchPhase | undefined,
): Promise<AgentActivity | undefined> {
	ownMailbox(name);
	const path = join(runtimePath(name), 'activity.json');
	return locked(`${path}.lock`, async () => {
		const current = await readActivity(name);
		if (!current || current.nonce !== nonce || !current.launch) return current;
		const launch = change(current, current.launch);
		if (!launch) return current;
		const next = { ...current, launch };
		// Engine observations do not rewrite the member's activity or its quiet-period timestamp.
		await atomicWrite(path, JSON.stringify(next));
		return next;
	});
}

export async function providerStarting(
	name: string,
	nonce: string,
	sessionId?: string,
): Promise<void> {
	await update(name, nonce, (_current, phase) => ({
		...phase,
		providerStartedAt: new Date().toISOString(),
		...(sessionId === undefined ? {} : { providerSessionId: sessionId }),
	}));
}

export async function providerUp(
	name: string,
	nonce: string,
	provider: Provider,
	evidence: LaunchPhase['evidence'],
): Promise<void> {
	await update(name, nonce, (_current, phase) =>
		phase.provider !== provider || ranks[phase.phase] >= ranks['logging-in']
			? undefined
			: { ...phase, phase: 'logging-in', since: new Date().toISOString(), evidence },
	);
}

export async function launchReady(name: string, nonce: string): Promise<void> {
	await update(name, nonce, (_current, phase) =>
		phase.phase === 'startup'
			? undefined
			: {
					...phase,
					phase: 'startup',
					since: new Date().toISOString(),
					evidence: 'mail-readiness',
				},
	);
}

/** A fresh saved model record is an observation of this exact Grok session, not a login proof. */
export async function observeGrokSession(
	name: string,
	nonce: string,
	info: ModelInfo | undefined,
	isRunning: () => boolean,
): Promise<AgentActivity | undefined> {
	return update(name, nonce, (_current, phase) => {
		if (
			!isRunning() ||
			phase.provider !== 'grok' ||
			phase.phase !== 'connecting' ||
			!phase.providerStartedAt ||
			info?.provider !== 'grok' ||
			info.sessionId !== phase.providerSessionId
		)
			return;
		const observed = Date.parse(info.observedAt);
		if (
			!Number.isFinite(observed) ||
			observed <= Date.parse(phase.providerStartedAt) ||
			observed > Date.now()
		)
			return;
		return {
			...phase,
			phase: 'logging-in',
			since: new Date().toISOString(),
			evidence: 'grok-session-metadata',
		};
	});
}
