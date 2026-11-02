import type { Team } from './team.ts';

import { recoverWakeError, retainWakeError, type WakeStage } from '../wake-errors.ts';
import { queueMentionWake } from './mention-wakes.ts';

function stageFor(key: string, slug: string): WakeStage {
	if (!key.startsWith(`${slug} `)) throw new Error('Invalid wake error subject.');
	return key.slice(slug.length + 1) as WakeStage;
}

export async function clearWakeError(key: string, slug: string): Promise<void> {
	await recoverWakeError(slug, stageFor(key, slug));
}

export async function reportWakeError(
	team: Team,
	key: string,
	error: unknown,
	slug: string,
	through: number | null = null,
): Promise<void> {
	const retained = await retainWakeError(slug, stageFor(key, slug), error, through);
	if (retained.changed)
		team.error(
			`${key}: ${retained.episode.reason} Wake episode ${retained.episode.id}; inspect summon --mail status.`,
			slug,
			`wake.${stageFor(key, slug).replaceAll(' ', '-')}`,
		);
}

/** Keep the unread target durable before allowing the shared room scan to advance. */
export async function retainFailedMention(
	team: Team,
	slug: string,
	through: number,
	error: unknown,
	notify = true,
): Promise<void> {
	await queueMentionWake(slug, through, notify);
	await reportWakeError(team, `${slug} mention wake`, error, slug, through);
}
