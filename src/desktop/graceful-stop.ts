import { setTimeout } from 'node:timers/promises';

import type { OwnedLaunch } from '../launch-phase-model.ts';
import type { TerminalProcess } from './team.ts';
import type { TeamAgent } from './types.ts';

import { readActivity } from '../agent-activity.ts';
import { grokTurn } from '../grok-turn-state.ts';
import { kiloTurn } from '../kilo-turn-state.ts';
import { terminalDraft } from './terminal-draft.ts';

const STOP_GRACE_MS = 5000;
const SUBMIT_DELAY_MS = 100;

interface StoppingSession {
	launch: OwnedLaunch;
	agent: TeamAgent;
	pty: TerminalProcess;
}

/** Sidebar idle is a prerequisite, not a substitute for available native busy/draft evidence. */
async function eligible(session: StoppingSession): Promise<boolean> {
	const { slug, provider } = session.agent;
	// Idle/draft observations do not distinguish Claude overlays or Codex approval prompts
	// from their composers. Never send synthetic Enter without native prompt evidence.
	if (provider === 'claude' || provider === 'codex') return false;
	const { nonce } = session.launch;
	const activity = await readActivity(slug);
	if (activity?.nonce !== nonce || activity.state !== 'idle' || activity.launch) return false;
	if (provider === 'grok') return (await grokTurn(slug, nonce))?.phase === 'idle';
	return (await kiloTurn(slug, nonce))?.phase === 'idle';
}

/** One attempt, never clear or submit a known human draft. Exit completion comes from the PTY. */
export async function tryGracefulStop(
	session: StoppingSession,
	current: () => boolean,
	wait: (milliseconds: number) => Promise<void> = setTimeout,
): Promise<void> {
	const running = (): boolean => current() && session.agent.status === 'running';
	const draft = terminalDraft(session.pty);
	if (!running() || draft.draft) return;
	try {
		if (!(await eligible(session)) || !running()) return;
		if (
			terminalDraft(session.pty).version !== draft.version ||
			terminalDraft(session.pty).draft
		)
			return;
		// All four providers document /exit. A separate Enter avoids paste/newline handling.
		session.pty.write('/exit');
		await wait(SUBMIT_DELAY_MS);
		if (!(await eligible(session))) return;
		if (!running() || terminalDraft(session.pty).version !== draft.version) return;
		session.pty.write('\r');
		const deadline = performance.now() + STOP_GRACE_MS;
		while (running() && performance.now() < deadline) await wait(50);
	} catch {
		// Missing/malformed observations and failed writes retain the existing forced-stop path.
	}
}
