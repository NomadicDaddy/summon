import type { Team } from './team.ts';

import { readActivity } from '../agent-activity.ts';
import { claudeInputHold, claudeNoticeHold } from '../claude-notice-hold.ts';
import {
	claudeNoticeAllowed,
	initializeClaudeTurn,
	reserveClaudeNotice,
} from '../claude-turn-state.ts';
import { assertCommunicationsOpen } from '../communication-state.ts';
import {
	grokNoticeAllowed,
	grokNoticeHold,
	initializeGrokTurn,
	reserveGrokNotice,
} from '../grok-turn-state.ts';
import {
	initializeKiloTurn,
	kiloNoticeAllowed,
	kiloNoticeHold,
	reserveKiloNotice,
} from '../kilo-turn-state.ts';
import { deliveryStatus } from '../mail-session.ts';
import { startMailWatcher } from '../mail-watcher.ts';
import {
	NotificationEnterWithheldError,
	NotificationNotSentError,
	NotificationUnsubmittedError,
} from '../notification-delivery.ts';
import { captureReceiverLaunch, receiverLaunch } from './claude-receiver-launch.ts';
import { claudeNoticeSender } from './claude-terminal-input.ts';
import { releaseWithheldNotice } from './claude-withheld-release.ts';
import { clearWakeError, reportWakeError } from './team-wake-errors.ts';
import { assertTerminalDraftClear, terminalDraft } from './terminal-draft.ts';

interface Receiver {
	nonce: string;
	stop: Promise<() => Promise<void>>;
}

const receivers = new WeakMap<Team, Map<string, Receiver>>();
const syncing = new WeakMap<Team, Promise<void>>();

/** The window delivers only into the exact PTY it owns; provider input queues active turns. */
export function syncTerminalReceivers(team: Team): Promise<void> {
	const previous = syncing.get(team);
	if (previous) return previous;
	const task = syncOwnedReceivers(team).finally(() => {
		if (syncing.get(team) === task) syncing.delete(team);
	});
	syncing.set(team, task);
	return task;
}

async function syncOwnedReceivers(team: Team): Promise<void> {
	let owned = receivers.get(team);
	if (!owned) {
		owned = new Map();
		receivers.set(team, owned);
	}
	const failures: unknown[] = [];
	for (const [slug, receiver] of owned) {
		const session = team.sessions.get(slug);
		if (team.closing || session?.agent.status !== 'running' || session.stopRequested) {
			try {
				await (
					await receiver.stop
				)();
				if (owned.get(slug) === receiver) owned.delete(slug);
			} catch (error: unknown) {
				try {
					await reportWakeError(team, `${slug} receiver initialization`, error, slug);
				} catch (persistError: unknown) {
					failures.push(persistError);
				}
			}
		}
	}
	if (team.closing) {
		if (failures.length)
			throw new AggregateError(failures, 'Could not retain receiver retirement errors.');
		return;
	}
	for (const [slug, session] of team.sessions) {
		const running = (): boolean =>
			!team.closing &&
			!session.stopRequested &&
			team.sessions.get(slug) === session &&
			session.agent.status === 'running';
		if (!running() || !session.terminalNotices) continue;
		try {
			const activity = await readActivity(slug);
			// Do not attach using a previous launch's retained activity record.
			if (!activity || activity.nonce === session.previousActivityNonce) continue;
			// Activity is initialized before the launch's delivery record is persisted.
			const thread = (await deliveryStatus(slug, activity.nonce)).thread;
			if (!thread) continue;
			const previous = owned.get(slug);
			if (previous?.nonce === activity.nonce) {
				await clearWakeError(`${slug} receiver initialization`, slug);
				continue;
			}
			if (previous) await (await previous.stop)();
			if (session.agent.provider === 'grok')
				await initializeGrokTurn(slug, activity.nonce, thread);
			if (session.agent.provider === 'kilo')
				await initializeKiloTurn(slug, activity.nonce, thread);
			if (session.agent.provider === 'claude') {
				await initializeClaudeTurn(slug, activity.nonce, thread);
				// Before this receiver can reserve, so human input always spends its tokens.
				captureReceiverLaunch(session.pty, activity.nonce);
			}
			if (receivers.get(team) !== owned || !running()) return;
			const assertReady = async (): Promise<void> => {
				await assertCommunicationsOpen();
				if (!running() || receivers.get(team) !== owned || owned.get(slug) !== receiver)
					throw new Error('The owned notification terminal is no longer running.');
			};
			const deliver =
				session.agent.provider === 'claude'
					? claudeNoticeSender(session.pty, assertReady)
					: async (text: string): Promise<void> => {
							try {
								await assertReady();
							} catch (error: unknown) {
								throw new NotificationNotSentError(
									error instanceof Error
										? error.message
										: 'Terminal is unavailable.',
									{ cause: error },
								);
							}
							assertTerminalDraftClear(session.pty);
							// Grok drops embedded line breaks; preserve their boundary as a space.
							session.pty.write(`${text.replace(/\r\n?|\n/g, ' ')}\r`);
						};
			const send = async (text: string): Promise<void> => {
				try {
					await deliver(text);
					await clearWakeError(`${slug} unsubmitted notice`, slug);
				} catch (error: unknown) {
					if (error instanceof NotificationUnsubmittedError)
						await reportWakeError(team, `${slug} unsubmitted notice`, error, slug);
					throw error;
				}
			};
			const receiver: Receiver = {
				nonce: activity.nonce,
				stop: startMailWatcher(
					slug,
					activity.nonce,
					async (text) => {
						let restore: (() => Promise<void>) | undefined;
						let token: string | undefined;
						if (['claude', 'grok', 'kilo'].includes(session.agent.provider)) {
							try {
								assertTerminalDraftClear(session.pty);
								if (session.agent.provider === 'claude') {
									// Only this terminal path can withhold its own Enter, so only it
									// mints a release token; the live channel never writes one.
									const reserved = await reserveClaudeNotice(
										slug,
										activity.nonce,
										true,
									);
									restore = reserved;
									token = reserved.token;
								} else
									restore =
										session.agent.provider === 'grok'
											? await reserveGrokNotice(slug, activity.nonce)
											: await reserveKiloNotice(slug, activity.nonce);
							} catch (error: unknown) {
								throw new NotificationNotSentError(
									'Provider notice waits for verified idle.',
									{ cause: error },
								);
							}
						}
						try {
							await send(text);
						} catch (error: unknown) {
							if (error instanceof NotificationNotSentError) await restore?.();
							else if (
								error instanceof NotificationEnterWithheldError &&
								token &&
								// Only the pane's current receiver releases; a retired one's tokens stay.
								receivers.get(team) === owned &&
								owned.get(slug) === receiver &&
								receiverLaunch(session.pty) === activity.nonce
							)
								await releaseWithheldNotice(
									session.pty,
									slug,
									activity.nonce,
									token,
									error,
								);
							throw error;
						}
					},
					{
						controlSend: send,
						readinessReminder: !['claude', 'grok', 'kilo'].includes(
							session.agent.provider,
						),
						noticeAllowed: async () => {
							if (!running() || terminalDraft(session.pty).draft) return false;
							const current = await readActivity(slug);
							return (
								(session.agent.provider !== 'claude' ||
									(await claudeNoticeAllowed(slug, activity.nonce))) &&
								(session.agent.provider !== 'grok' ||
									(await grokNoticeAllowed(slug, activity.nonce))) &&
								current?.nonce === activity.nonce &&
								(session.agent.provider !== 'kilo' ||
									(await kiloNoticeAllowed(slug, activity.nonce)))
							);
						},
						// Only this running launch reports why its native turn gate holds notices, so a
						// held wake is visible rather than silent. A human draft holds Claude too, and
						// says so. Other providers' pane drafts do not advertise Claude's release keys.
						...(['kilo', 'claude', 'grok'].includes(session.agent.provider)
							? {
									noticeHold: async () => {
										if (!running()) return undefined;
										const draft = terminalDraft(session.pty).draft;
										if (draft && session.agent.provider !== 'claude')
											return undefined;
										if ((await readActivity(slug))?.nonce !== activity.nonce)
											return undefined;
										if (draft) return claudeInputHold(slug, activity.nonce);
										const hold =
											session.agent.provider === 'grok'
												? await grokNoticeHold(slug, activity.nonce)
												: session.agent.provider === 'kilo'
													? await kiloNoticeHold(slug, activity.nonce)
													: await claudeNoticeHold(slug, activity.nonce);
										return hold ?? null;
									},
								}
							: {}),
					},
				),
			};
			owned.set(slug, receiver);
			try {
				await receiver.stop;
				await clearWakeError(`${slug} receiver initialization`, slug);
			} catch (error: unknown) {
				if (owned.get(slug) === receiver) owned.delete(slug);
				throw error;
			}
		} catch (error: unknown) {
			try {
				await reportWakeError(team, `${slug} receiver initialization`, error, slug);
			} catch (persistError: unknown) {
				failures.push(persistError);
			}
		}
	}
	if (failures.length)
		throw new AggregateError(failures, 'Could not retain receiver initialization errors.');
}

export async function stopTerminalReceivers(team: Team): Promise<void> {
	const owned = receivers.get(team);
	if (!owned) return;
	receivers.delete(team);
	const pending = syncing.get(team);
	const results = await Promise.allSettled([
		pending,
		(async () => {
			await pending?.catch(() => {});
			const stops = await Promise.allSettled(
				[...owned.values()].map(async (receiver) => (await receiver.stop)()),
			);
			const failures = stops.flatMap((result) =>
				result.status === 'rejected' ? [result.reason as unknown] : [],
			);
			if (failures.length)
				throw new AggregateError(failures, 'Could not stop terminal receivers.');
		})(),
	]);
	const failures = results.flatMap((result) =>
		result.status === 'rejected' ? [result.reason as unknown] : [],
	);
	if (failures.length) throw new AggregateError(failures, 'Could not stop terminal receivers.');
}
