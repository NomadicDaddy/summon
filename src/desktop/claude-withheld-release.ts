import type { TerminalProcess } from './team.ts';

import { releaseWithheldClaudeNotice } from '../claude-notice-release.ts';
import { type NotificationEnterWithheldError } from '../notification-delivery.ts';
import { saveTerminalDraft, terminalDraft } from './terminal-draft.ts';

/**
 * Summon withheld its own Enter, so only this reservation's busy hold is released. The pane mark
 * Summon set for its own paste clears only when no human input has arrived since and Claude itself
 * reported the text and then an empty box; human input keeps its pane hold. Best effort: the
 * original refusal and its uncertain outcome stand whatever happens here, and nothing is retried.
 */
export async function releaseWithheldNotice(
	pty: TerminalProcess,
	name: string,
	nonce: string,
	token: string,
	refusal: NotificationEnterWithheldError,
): Promise<void> {
	try {
		const released = await releaseWithheldClaudeNotice(name, nonce, token);
		if (released && !released.draft && terminalDraft(pty).version === refusal.pasteVersion)
			saveTerminalDraft(pty, refusal.pasteVersion, false);
	} catch {
		/* The refusal already explains the hold; a failed release leaves it held. */
	}
}
