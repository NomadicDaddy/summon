import type { StopResult, TeamAgent } from './types.ts';

/**
 * Whether Stop must ask first. It asks when anything says the session may be working: the
 * teammate's own busy or needs-user status, the provider's turn record (busy, or a phase it
 * cannot read as idle), or a running session whose status could not be observed. Only a session
 * with no such evidence stops at once.
 */
export function stopNeedsConfirm(agent: TeamAgent): boolean {
	return (
		agent.activity === 'busy' ||
		agent.activity === 'needs-user' ||
		agent.providerTurn !== undefined ||
		agent.observationUnavailable === true
	);
}

/**
 * The Stop button: ask when the snapshot shows work, then send the stop saying whether the
 * operator already accepted. Codex roster evidence is cached, so its Stop first asks the main
 * process for a fresh decision. Other snapshots can be up to 2 s old; the main process looks again
 * (stop-evidence.ts) and refuses an unconfirmed stop of a session it finds working; that refusal
 * asks the same question here before a confirmed retry. `ask` is window.confirm in the renderer.
 * It answers with the main process's last word, or nothing when the operator cancelled. An
 * unverified answer comes back as it is: never asked again, never thrown, never sent again.
 */
export async function stopWithConfirm(
	agent: TeamAgent,
	ask: (message: string) => boolean,
	stop: (confirmed: boolean) => Promise<StopResult>,
): Promise<StopResult | undefined> {
	const message = `Stop ${agent.name}? Unsaved work in its session will be terminated.`;
	const confirmed = agent.provider !== 'codex' && stopNeedsConfirm(agent);
	if (confirmed && !ask(message)) return undefined;
	const result = await stop(confirmed);
	if (!('needsConfirm' in result)) return result;
	return ask(message) ? stop(true) : undefined;
}
