import { setTimeout } from 'node:timers/promises';

import type { TerminalProcess } from './team.ts';

import {
	NotificationEnterWithheldError,
	NotificationNotSentError,
	NotificationUnsubmittedError,
} from '../notification-delivery.ts';
import { recordTerminalDraft, saveTerminalDraft, terminalDraft } from './terminal-draft.ts';

const SUBMIT_DELAY_MS = 100;

/** Human input belongs to the human; an automatic Enter must never submit their draft. */
export function recordClaudeInput(pty: TerminalProcess, data: string, humanInput = true): void {
	recordTerminalDraft(pty, data, humanInput, true);
}

/** Claude treats text plus CR in one input burst as a pasted newline, not submission. */
export function claudeNoticeSender(
	pty: TerminalProcess,
	assertReady: () => Promise<void>,
	wait: () => Promise<void> = () => setTimeout(SUBMIT_DELAY_MS),
): (text: string) => Promise<void> {
	let pending = Promise.resolve();
	return (text) => {
		const delivery = pending.then(async () => {
			try {
				await assertReady();
			} catch (error: unknown) {
				throw new NotificationNotSentError(
					error instanceof Error ? error.message : 'Claude terminal is unavailable.',
					{ cause: error },
				);
			}
			const state = terminalDraft(pty);
			if (state.draft)
				throw new NotificationNotSentError(
					'Claude notice waits for the human input draft.',
				);
			const version = state.version;
			saveTerminalDraft(pty, version, true);
			try {
				pty.write(`\u001b[200~${text}\u001b[201~`);
				await wait();
			} catch (error: unknown) {
				throw new NotificationUnsubmittedError(error);
			}
			// Only these two refusals come after the paste and before any Enter is written.
			try {
				await assertReady();
				if (terminalDraft(pty).version !== version)
					throw new Error('Human input changed before the Claude notice could submit.');
			} catch (error: unknown) {
				throw new NotificationEnterWithheldError(error, version);
			}
			try {
				pty.write('\r');
				saveTerminalDraft(pty, version, false);
			} catch (error: unknown) {
				throw new NotificationUnsubmittedError(error);
			}
		});
		pending = delivery.catch(() => {});
		return delivery;
	};
}
