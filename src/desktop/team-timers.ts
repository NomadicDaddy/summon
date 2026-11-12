import type { MentionScanDiagnostic, MentionScanStage } from './mention-scan-metrics.ts';
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
	onMentionDiagnostic?: (diagnostic: MentionScanDiagnostic) => void;
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
	let mentionStarted: number | null = null;
	let mentionStage: MentionScanStage | null = null;
	let skippedMentionTicks = 0;
	const halted = (): boolean => stopped || deps.halted() || team.closing;
	const run = async (key: string, work: () => Promise<void>): Promise<void> => {
		if (halted()) return;
		if (pending.has(key)) {
			if (key === 'mentions') {
				skippedMentionTicks++;
				deps.onMentionDiagnostic?.({
					kind: 'overlap',
					at: new Date().toISOString(),
					activeStage: mentionStage,
					elapsedMs:
						mentionStarted === null
							? 0
							: Math.round(performance.now() - mentionStarted),
					skippedTicks: skippedMentionTicks,
				});
			}
			return;
		}
		if (key === 'mentions') skippedMentionTicks = 0;
		const task = Promise.resolve()
			.then(work)
			.catch((error: unknown) => team.error(error))
			.finally(() => pending.delete(key));
		pending.set(key, task);
		await task;
	};
	const scanMentions = (): Promise<void> =>
		run('mentions', async () => {
			const started = performance.now();
			mentionStarted = started;
			const stagesMs: Partial<Record<MentionScanStage, number>> = {};
			let outcome: 'complete' | 'paused' | 'failed' = 'complete';
			const measure = async <T>(
				stage: MentionScanStage,
				action: () => Promise<T>,
			): Promise<T> => {
				const previousStage = mentionStage;
				mentionStage = stage;
				const began = performance.now();
				try {
					return await action();
				} finally {
					stagesMs[stage] = Math.round(
						(stagesMs[stage] ?? 0) + performance.now() - began,
					);
					mentionStage = previousStage;
				}
			};
			const paused = async (): Promise<boolean> =>
				(await measure('communication', communicationState)).paused;
			try {
				await measure('hibernation', () => team.syncHibernation());
				if (await paused()) {
					outcome = 'paused';
					return;
				}
				await measure('schedules', () =>
					tickSchedules(team).catch((error: unknown) => team.error(error)),
				);
				await measure('rest', () =>
					tickRest(team).catch((error: unknown) => team.error(error)),
				);
				if (!recoveredMentions) {
					if (await measure('settings', readWakeOnMention)) {
						const events = await measure('events', cachedLocalEvents);
						await measure('recovery', () =>
							team.recoverMissedMentionWakes(events, deps.previousTeamStart),
						);
					}
					recoveredMentions = true;
				}
				for (const event of await measure('events', cachedLocalEvents)) {
					if (event.id <= mentionCursor) continue;
					if (await paused()) {
						outcome = 'paused';
						return;
					}
					if (await measure('settings', readWakeOnMention))
						await measure('wake', () => team.wakeMentions(event));
					mentionCursor = event.id;
					await measure('cursor', () => saveMentionCursor(mentionCursor));
				}
				if (await paused()) {
					outcome = 'paused';
					return;
				}
				if (await measure('settings', readWakeOnMention))
					await measure('flush', () => team.flushPendingMentionWakes());
			} catch (error: unknown) {
				outcome = 'failed';
				throw error;
			} finally {
				mentionStarted = null;
				mentionStage = null;
				deps.onMentionDiagnostic?.({
					kind: 'scan',
					at: new Date().toISOString(),
					durationMs: Math.round(performance.now() - started),
					stagesMs,
					skippedTicks: skippedMentionTicks,
					outcome,
				});
			}
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
