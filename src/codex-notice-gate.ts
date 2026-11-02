import type { CodexTurnPhase } from './codex-turn-rpc.ts';

import { codexTurn } from './codex-turn.ts';
import { noticesHeldPrefix } from './mail-session.ts';

/**
 * Only a positive busy observation holds ordinary notices: read coverage does not finish a native
 * turn, so a busy turn keeps later work queued. Unknown, including a failed read, is not evidence
 * of a turn. Where no Codex app-server daemon runs every read is unknown, and holding on it left
 * seats deaf to all ordinary work, so unknown delivers as before the busy-turn hold. Coalescing
 * and the pre-send rechecks still apply, and unknown is never reported as verified idle.
 */
export function codexNoticeGate(name: string, nonce: string) {
	let phase: CodexTurnPhase = 'unknown';
	return {
		noticeCheckWhenPending: true,
		noticeAllowed: async (): Promise<boolean> => {
			phase = await codexTurn(name, nonce).catch(() => 'unknown' as const);
			return phase !== 'busy';
		},
		noticeHold: (pending: boolean): Promise<string | null> => {
			// Consumed work cannot lend its old busy observation to an empty cycle. Fresh work
			// still goes through noticeAllowed; clearing this label never establishes native idle.
			if (!pending) phase = 'unknown';
			return Promise.resolve(
				phase === 'busy' ? `${noticesHeldPrefix}Codex native busy.` : null,
			);
		},
	};
}
