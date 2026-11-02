import type { LocalEvent } from '../local-room.ts';
import type { Team } from './team.ts';

import { humanOrHeadDownSteering } from '../automatic-interruptions.ts';
import { automaticNoticeSuppressed } from '../automatic-notice.ts';
import { cachedLocalEvents } from '../local-room.ts';
import { optionalText } from '../mail-files.ts';
import { restSuppressed } from '../rest.ts';
import { localCursorPath, roomCursor } from '../room-cursor.ts';
import { groupWakeTargets } from '../room-groups.ts';
import { answerRecipient } from '../room-question.ts';
import { startableNames } from '../room-wake.ts';
import { listAgentSlugs, loadAgent } from '../store.ts';
import { clearMentionWake, queueMentionWake, readPendingMentionWake } from './mention-wakes.ts';
import { clearWakeError, reportWakeError, retainFailedMention } from './team-wake-errors.ts';

export async function wakeTeamMentions(team: Team, event: LocalEvent): Promise<void> {
	const slugs = await listAgentSlugs();
	const recipient = event.answer ? answerRecipient(event, await cachedLocalEvents()) : undefined;
	const targets = new Set(startableNames(event, slugs));
	if (recipient && slugs.includes(recipient)) targets.add(recipient);
	const running = (slug: string): boolean => team.sessions.get(slug)?.agent.status === 'running';
	for (const slug of groupWakeTargets(event, slugs, running)) targets.add(slug);
	const failures: unknown[] = [];
	for (const slug of targets) {
		try {
			if (await wakeTarget(team, slug, event))
				await clearWakeError(`${slug} mention wake`, slug);
		} catch (error: unknown) {
			try {
				const notify = await humanOrHeadDownSteering(event, slug).catch(() => false);
				await retainFailedMention(team, slug, event.id, error, notify);
			} catch (persistError: unknown) {
				failures.push(persistError);
			}
		}
	}
	await team.flushPendingMentionWakes();
	if (failures.length)
		throw new AggregateError(failures, 'Could not retain failed mention wakes.');
}

async function wakeTarget(team: Team, slug: string, event: LocalEvent): Promise<boolean> {
	if (await restSuppressed(slug)) return false;
	const record = await loadAgent(slug);
	const session = team.sessions.get(slug);
	if (record?.hibernation?.active) {
		team.error(`${slug} was not woken: hibernated by the operator.`, slug);
		return false;
	}
	if (
		(await humanOrHeadDownSteering(event, slug)) &&
		session?.agent.status === 'running' &&
		record?.provider === 'kilo'
	) {
		const cursor = roomCursor((await optionalText(localCursorPath(slug))) ?? '0');
		if (cursor < event.id) await queueMentionWake(slug, event.id);
	}
	await team.start(slug, false, 'mention');
	return team.sessions.get(slug)?.agent.status === 'running';
}

export async function flushTeamMentionWakes(team: Team): Promise<void> {
	const failures: unknown[] = [];
	try {
		await team.syncHibernation();
	} catch (error: unknown) {
		failures.push(error);
	}
	for (const slug of await listAgentSlugs()) {
		try {
			if (await flushTarget(slug)) await clearWakeError(`${slug} pending wake`, slug);
		} catch (error: unknown) {
			const pending = await readPendingMentionWake(slug).catch(() => undefined);
			try {
				await reportWakeError(team, `${slug} pending wake`, error, slug, pending?.through);
			} catch (persistError: unknown) {
				failures.push(persistError);
			}
		}
	}
	if (failures.length)
		throw new AggregateError(failures, 'Could not retain pending wake errors.');
}

async function flushTarget(slug: string): Promise<boolean> {
	if (await automaticNoticeSuppressed(slug)) return false;
	const pending = await readPendingMentionWake(slug);
	if (!pending || pending.through === 0) return false;
	const cursor = roomCursor((await optionalText(localCursorPath(slug))) ?? '0');
	if (cursor >= pending.through) {
		await clearMentionWake(slug, cursor);
		return true;
	}
	// Every supported launch uses its receiver; pending mention retention clears only after reading.
	return false;
}
