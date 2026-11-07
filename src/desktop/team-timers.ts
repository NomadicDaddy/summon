import type { Team } from './team.ts';
import type { TeamEvent } from './types.ts';

import { readBoard } from '../board.ts';
import { communicationState } from '../communication-state.ts';
import { cachedLocalEvents } from '../local-room.ts';
import { saveMentionCursor } from '../team-mentions.ts';
import { readWakeOnMention } from '../team-settings.ts';
import { tickRest } from './rest.ts';
import { tickSchedules } from './schedules.ts';
import { syncTerminalReceivers } from './terminal-receivers.ts';

interface TimerDependencies {
	team: Team;
	send: (event: TeamEvent) => void;
	canSend: () => boolean;
	halted: () => boolean;
	initialCursor: number;
	previousTeamStart: string | null | undefined;
}

/** Polling belongs to the window lifecycle; no Electron import is needed to exercise it. */
export function createTeamTimers(deps: TimerDependencies): {
	scanMentions: () => Promise<void>;
	checkRoster: () => Promise<void>;
	checkBoard: () => Promise<void>;
	start: () => void;
	stop: () => Promise<void>;
} {
	const { team } = deps;
	let mentionCursor = deps.initialCursor;
	let recoveredMentions = false;
	let lastRoster = '';
	let lastRevision = -1;
	let stopped = false;
	let intervals: ReturnType<typeof setInterval>[] = [];
	const pending = new Map<string, Promise<void>>();
	const halted = (): boolean => stopped || deps.halted() || team.closing;
	const run = async (key: string, work: () => Promise<void>): Promise<void> => {
		if (halted() || pending.has(key)) return;
		const task = Promise.resolve()
			.then(work)
			.catch((error: unknown) => team.error(error))
			.finally(() => pending.delete(key));
		pending.set(key, task);
		await task;
	};
	const scanMentions = (): Promise<void> =>
		run('mentions', async () => {
			await team.syncHibernation();
			if ((await communicationState()).paused) return;
			await tickSchedules(team).catch((error: unknown) => team.error(error));
			await tickRest(team).catch((error: unknown) => team.error(error));
			if (!recoveredMentions) {
				if (await readWakeOnMention())
					await team.recoverMissedMentionWakes(
						await cachedLocalEvents(),
						deps.previousTeamStart,
					);
				recoveredMentions = true;
			}
			for (const event of await cachedLocalEvents()) {
				if (event.id <= mentionCursor) continue;
				if ((await communicationState()).paused) return;
				if (await readWakeOnMention()) await team.wakeMentions(event);
				mentionCursor = event.id;
				await saveMentionCursor(mentionCursor);
			}
			if ((await communicationState()).paused) return;
			if (await readWakeOnMention()) await team.flushPendingMentionWakes();
		});
	const checkRoster = (): Promise<void> =>
		run('roster', async () => {
			await syncTerminalReceivers(team);
			const value = await team.snapshot();
			const encoded = JSON.stringify(value);
			if (!halted() && deps.canSend() && encoded !== lastRoster) {
				lastRoster = encoded;
				deps.send({ type: 'snapshot', value });
			}
		});
	// Other CLI processes write the Board. Its document revision includes comments, so roster
	// changes alone cannot drive refreshes. Poll it independently and send only changed revisions.
	const checkBoard = (): Promise<void> =>
		run('board', async () => {
			const { revision } = await readBoard();
			if (halted() || !deps.canSend() || revision === lastRevision) return;
			lastRevision = revision;
			deps.send({ type: 'board' });
		});
	return {
		scanMentions,
		checkRoster,
		checkBoard,
		start: () => {
			if (intervals.length) return;
			stopped = false;
			intervals = [scanMentions, checkRoster, checkBoard].map((poll) =>
				setInterval(() => void poll(), 2000),
			);
		},
		stop: async () => {
			stopped = true;
			for (const timer of intervals) clearInterval(timer);
			intervals = [];
			await Promise.all(pending.values());
		},
	};
}
