import type { LaunchPhaseView } from '../launch-phase-model.ts';
import type { TeamAgent } from './types.ts';

/*
 * LAUNCH PHASES (card 0674e3b6). From the moment a session process is spawned until the member's
 * first explicit status call, the row used to read "Ready" with a green dot: the one stretch in
 * which nothing is ready. The main process now says which of three phases the launch is in, with
 * the observation that put it there. The phase is a fact beside the self-reported state, never a
 * value of it: Busy and Needs you are things the member said and always win; the phase only
 * replaces the idle fallback. "Logging in" means the CLI showed itself, and the tooltip says so in
 * as many words - Summon never checks sign-in.
 */
const launchLabels: Record<LaunchPhaseView['phase'], string> = {
	connecting: 'Connecting…',
	'logging-in': 'Logging in…',
	startup: 'Summon startup…',
};
const launchEvidence: Record<LaunchPhaseView['evidence'], string> = {
	'owned-process-spawn': 'The session process has started; waiting for the CLI to show itself.',
	'claude-mcp-initialized': 'Claude initialised its MCP connection.',
	'codex-session-start': 'Codex reported its session start.',
	'grok-session-metadata': 'Grok wrote fresh session metadata for this launch.',
	'kilo-owned-session': 'Kilo answered for its own session.',
	'mail-readiness': 'Mail readiness was acknowledged for this launch.',
};
const NO_LOGIN_CLAIM = 'Sign-in is not checked by Summon; the CLI handles it.';
/**
 * A provider can stop at a first-run question, such as Claude's folder-trust prompt, and Summon
 * can't tell that from a slow start (remediation-20261021-roster-shows-provider-first-run-prompt).
 * So it claims nothing: it says where to look, and never answers for the operator (Phillip #19108).
 */
export const CONNECTING_HINT =
	'If this goes on, the provider may be asking a question in its pane. Answer it there.';

/** The phase name without its ellipsis, for sentences. */
function phaseName(view: LaunchPhaseView): string {
	return launchLabels[view.phase].replace('…', '');
}

/** The row's wording for an active launch, or undefined when the owned session has none. */
export function launchLabel(agent: Pick<TeamAgent, 'launch' | 'status'>): string | undefined {
	return agent.status === 'running' && agent.launch
		? launchLabels[agent.launch.phase]
		: undefined;
}

export function launchTooltip(view: LaunchPhaseView): string {
	const since = new Date(view.since).toLocaleTimeString();
	const lines = [`${phaseName(view)} since ${since}.`, launchEvidence[view.evidence]];
	if (view.phase === 'connecting') lines.push(CONNECTING_HINT);
	if (view.phase === 'logging-in') lines.push(NO_LOGIN_CLAIM);
	if (view.phase === 'startup') lines.push('Waiting for the first status call.');
	return lines.join('\n');
}

/** A sentence for a session that ended before its first status call, or empty. */
export function launchEndedNote(agent: Pick<TeamAgent, 'launchEnded' | 'status'>): string {
	// Only an ended session owns this note: elsewhere means another window is running it now.
	const view = agent.launchEnded;
	if (!view || agent.status !== 'exited') return '';
	return `Ended while ${phaseName(view).toLowerCase()} (${launchEvidence[view.evidence]})`;
}
