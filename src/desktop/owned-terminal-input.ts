import type { TerminalProcess } from './team.ts';
import type { TeamAgent } from './types.ts';

import { readActivity } from '../agent-activity.ts';
import { spendClaudeRelease } from '../claude-notice-release.ts';
import { claudeInputSubmitted } from '../claude-turn-state.ts';
import { grokInputSubmitted } from '../grok-turn-state.ts';
import { isHibernated } from '../hibernation.ts';
import { kiloInputSubmitted } from '../kilo-turn-state.ts';
import { receiverLaunch } from './claude-receiver-launch.ts';
import { recordClaudeInput } from './claude-terminal-input.ts';
import { MAX_TERMINAL_INPUT, validTerminalSize } from './pty-process.ts';
import { recordTerminalDraft, saveTerminalDraft, terminalDraft } from './terminal-draft.ts';

/** Preserve the existing provider draft gates while Team keeps lifecycle recording bounded. */
export async function inputToOwnedTerminal(
	slug: string,
	data: string,
	humanInput: boolean,
	currentSession: () =>
		| {
				agent: TeamAgent;
				pty: TerminalProcess;
				terminalNotices: boolean;
				stopRequested?: boolean;
		  }
		| undefined,
	wakeReceiver?: (name: string, nonce: string) => void,
): Promise<void> {
	if (data.length > MAX_TERMINAL_INPUT) throw new Error('Terminal input is too large.');
	if (await isHibernated(slug)) throw new Error(`${slug} is hibernated; use Unhibernate first.`);
	const session = currentSession();
	if (session?.agent.status !== 'running' || session.stopRequested) return;
	if (
		humanInput &&
		['claude', 'grok', 'kilo'].includes(session.agent.provider) &&
		(session.agent.provider !== 'claude' || session.terminalNotices) &&
		/^(?:\r|\n|\r\n)$/.test(data)
	) {
		// PTY notices must not race human Enter. Claude's native channel never types into the
		// composer; its authenticated native hooks, rather than an ignored empty Enter, own busy.
		const submissionVersion = terminalDraft(session.pty).version + 1;
		saveTerminalDraft(session.pty, submissionVersion, true);
		// Claude records the submission for the launch its receiver captured, as coalesced input
		// below does, so a missing or unreadable activity.json can't let an Enter skip the record.
		const captured =
			session.agent.provider === 'claude' ? receiverLaunch(session.pty) : undefined;
		const nonce = captured ?? (await readActivity(slug))?.nonce;
		const current = currentSession();
		if (current !== session || current.agent.status !== 'running' || current.stopRequested)
			return;
		if (nonce) {
			if (session.agent.provider === 'grok') await grokInputSubmitted(slug, nonce);
			else if (session.agent.provider === 'claude') await claudeInputSubmitted(slug, nonce);
			else await kiloInputSubmitted(slug, nonce);
		}
		const latest = currentSession();
		if (latest !== session || latest.stopRequested) return;
		session.pty.write(data);
		// Concurrent typing owns a newer draft and must survive this older submission.
		if (terminalDraft(session.pty).version === submissionVersion)
			saveTerminalDraft(session.pty, submissionVersion + 1, false);
		return;
	}
	// Coalesced keys and pastes can carry a submitting line break, so they spend the token first,
	// for the launch the pane's receiver captured, whether or not activity.json reads right now.
	const launch = receiverLaunch(session.pty);
	const draftBefore = terminalDraft(session.pty).draft;
	if (humanInput && session.agent.provider === 'claude' && launch && /[\r\n]/.test(data)) {
		await spendClaudeRelease(slug, launch);
		const latest = currentSession();
		if (latest !== session || latest.stopRequested) return;
	}
	if (session.agent.provider === 'claude') recordClaudeInput(session.pty, data, humanInput);
	else recordTerminalDraft(session.pty, data, humanInput, session.agent.provider === 'grok');
	session.pty.write(data);
	if (draftBefore && !terminalDraft(session.pty).draft) {
		const nonce = launch ?? (await readActivity(slug))?.nonce;
		if (nonce && currentSession() === session) wakeReceiver?.(slug, nonce);
	}
}

export function resizeOwnedTerminal(
	slug: string,
	cols: number,
	rows: number,
	dimensions: Map<string, { cols: number; rows: number }>,
	sessions: ReadonlyMap<string, { agent: TeamAgent; pty: TerminalProcess }>,
): void {
	if (!validTerminalSize(cols, rows)) return;
	const previous = dimensions.get(slug);
	if (previous?.cols === cols && previous.rows === rows) return;
	dimensions.set(slug, { cols, rows });
	const session = sessions.get(slug);
	if (session?.agent.status === 'running') session.pty.resize(cols, rows);
}
