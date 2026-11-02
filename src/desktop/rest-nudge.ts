import { join } from 'node:path';

import type { Team } from './team.ts';

import { readActivity } from '../agent-activity.ts';
import { assertAutomaticNoticeAllowed, automaticNoticeSuppressed } from '../automatic-notice.ts';
import { atomicWrite, locked, optionalText } from '../mail-files.ts';
import { runtimePath } from '../mail-session.ts';
import { sendMessage } from '../mailbox.ts';
import { providerTurn } from '../provider-turn.ts';
import { assertTerminalDraftClear } from './terminal-draft.ts';

/** After busy or unknown turn evidence, how long before the same idle episode is read again. */
export const HELD_RECHECK_MS = 60_000;
const heldEvidence = new Map<string, { episode: string; until: number }>();

/** One question per idle episode, never a derived confirmation or a stop. */
export async function nudgeRest(team: Team, name: string, now = Date.now()): Promise<void> {
	if (await automaticNoticeSuppressed(name)) return;
	const session = team.sessions.get(name);
	if (session?.agent.status !== 'running') return;
	const activity = await readActivity(name);
	if (
		activity?.state !== 'idle' ||
		!Number.isFinite(Date.parse(activity.updatedAt)) ||
		now - Date.parse(activity.updatedAt) < 10 * 60000
	)
		return;
	// A self-reported idle is only a claim: activity from another launch says nothing about this
	// one (tool-aware-idle-nudge).
	if (activity.nonce !== session.launch.nonce) return;
	// This asks the agent to reconcile its work. Requiring rest eligibility here would
	// suppress the question precisely when stale cards or unread mail need that review.
	// The separate --rest ready command still enforces every eligibility check.
	const path = join(runtimePath(name), 'rest-nudge');
	await locked(`${path}.lock`, async () => {
		const episode = `${activity.nonce}:${activity.updatedAt}`;
		if ((await optionalText(path)) === episode) return;
		// A provider turn still running (a long tool call) means the agent isn't idle. Busy,
		// unreadable or missing evidence is unknown, never idle by absence; for Codex that includes
		// an unavailable daemon. The Codex read is a live daemon call and the rest tick runs every
		// 2 s, so after busy or unknown the same episode isn't read again for a while.
		const held = heldEvidence.get(name);
		if (held?.episode === episode && now < held.until) return;
		if (
			await providerTurn(session.agent.provider, name, session.launch.nonce, {
				missingIsUnknown: true,
			})
		) {
			heldEvidence.set(name, { episode, until: now + HELD_RECHECK_MS });
			return;
		}
		heldEvidence.delete(name);
		const message =
			'You have been idle for a while. Please check your cards, mail and scheduled duties. Update any unrecorded work. If nothing is actionable and you are ready for the operator to stop your session, explicitly confirm with summon --rest ready. Stay busy if you have unfinished work; this question does not stop you.';
		await assertAutomaticNoticeAllowed(name);
		if (session.agent.provider === 'kilo') assertTerminalDraftClear(session.pty);
		await sendMessage(name, name, message, {
			system: { purpose: 'rest-nudge', nonce: activity.nonce, idleSince: activity.updatedAt },
		});
		await atomicWrite(path, episode);
	});
}
