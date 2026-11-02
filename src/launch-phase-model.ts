import { z } from 'zod';

import { providers, sessionIdPattern } from './store.ts';

export const launchPhaseSchema = z.object({
	phase: z.enum(['connecting', 'logging-in', 'startup']),
	since: z.iso.datetime(),
	evidence: z.enum([
		'owned-process-spawn',
		'claude-mcp-initialized',
		'codex-session-start',
		'grok-session-metadata',
		'kilo-owned-session',
		'mail-readiness',
	]),
	provider: z.enum(providers),
	providerStartedAt: z.iso.datetime().optional(),
	providerSessionId: z.string().regex(sessionIdPattern).optional(),
});
export type LaunchPhase = z.infer<typeof launchPhaseSchema>;
export type LaunchPhaseView = Pick<LaunchPhase, 'phase' | 'since' | 'evidence'>;
export interface OwnedLaunch {
	nonce: string;
	since: string;
}

/** Provider identifiers and the nonce remain main-side; the renderer gets only status evidence. */
export function launchPhaseView(phase: LaunchPhase): LaunchPhaseView {
	return { phase: phase.phase, since: phase.since, evidence: phase.evidence };
}
