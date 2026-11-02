import type { LocalEvent } from '../local-room.ts';

import { optionalText } from '../mail-files.ts';
import { localCursorPath, roomCursor } from '../room-cursor.ts';
import { groupWakeTargets } from '../room-groups.ts';
import { answerRecipient } from '../room-question.ts';
import { startableNames } from '../room-wake.ts';
import { listAgentSlugs, loadAgent } from '../store.ts';
import { queueMentionWake } from './mention-wakes.ts';

export async function recoverMissedMentionWakes(
	events: LocalEvent[],
	since: string | null | undefined,
	isRunning: (slug: string) => boolean,
	start: (slug: string) => Promise<unknown>,
	skipped: (slug: string) => void = () => {},
	failed: (slug: string, through: number, error: unknown) => Promise<void> = (
		_slug,
		_through,
		error,
	) => Promise.reject(error instanceof Error ? error : new Error(String(error))),
): Promise<void> {
	if (!since) return;
	const startedAt = Date.parse(since);
	if (!Number.isFinite(startedAt)) throw new Error('Invalid previous team window start.');
	const slugs = await listAgentSlugs();
	const failures: unknown[] = [];
	for (const event of events) {
		const eventAt = Date.parse(event.at);
		if (
			!Number.isFinite(eventAt) ||
			eventAt <= startedAt ||
			!['user', 'cli'].includes(event.sender.kind)
		)
			continue;
		const targets = new Set(startableNames(event, slugs));
		const recipient = answerRecipient(event, events);
		if (recipient && slugs.includes(recipient)) targets.add(recipient);
		for (const slug of groupWakeTargets(event, slugs, isRunning)) targets.add(slug);
		for (const slug of targets) {
			try {
				const record = await loadAgent(slug);
				if (record?.hibernation?.active) {
					skipped(slug);
					continue;
				}
				if (record?.provider !== 'grok' && record?.provider !== 'kilo') continue;
				const cursor = roomCursor((await optionalText(localCursorPath(slug))) ?? '0');
				if (cursor >= event.id) continue;
				if (isRunning(slug)) await queueMentionWake(slug, event.id);
				else await start(slug);
			} catch (error: unknown) {
				try {
					await failed(slug, event.id, error);
				} catch (persistError: unknown) {
					failures.push(persistError);
				}
			}
		}
	}
	if (failures.length)
		throw new AggregateError(failures, 'Could not retain missed mention wakes.');
}
