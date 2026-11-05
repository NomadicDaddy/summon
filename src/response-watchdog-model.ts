import { z } from 'zod';

const timestamp = z.number().nonnegative();
const condition = z.enum(['blocked', 'awaiting-read', 'uncertain', 'inventory']);
const expectation = z
	.object({
		id: z.string().min(1).max(256),
		condition,
		startedAt: timestamp,
		progressAt: timestamp,
		progress: z.number().int().nonnegative(),
	})
	.strict();

export const responseEpisodeSchema = z
	.object({
		version: z.literal(1),
		owner: z.string().min(1).max(64),
		nonce: z.string().regex(/^[a-z0-9-]+$/i),
		id: z.uuid(),
		updatedAt: timestamp,
		suspended: z.boolean(),
		dismissed: z.boolean(),
		alerted: z.boolean(),
		episodeTargets: z.array(z.string()).max(10000),
		diagnostic: z.enum(['none', 'clock-reset', 'state-reset']),
		expectations: z.array(expectation).max(10000),
	})
	.strict();

export type ResponseEpisode = z.infer<typeof responseEpisodeSchema>;
export interface ResponseObservation {
	id: string;
	condition: z.infer<typeof condition>;
	/** Monotonic, target-specific read progress; never a heartbeat or display invocation. */
	progress: number;
}

const responseWaitingMs = 5 * 60 * 1000;
const responseAlertMs = 10 * 60 * 1000;

/** Keep waiting and alert transitions independent of the ordinary receiver rescan. */
export function responseEpisodeDeadline(
	episode: ResponseEpisode,
	now = Date.now(),
): number | undefined {
	if (episode.suspended || episode.dismissed) return;
	const future = episode.expectations.flatMap((item) =>
		[item.progressAt + responseWaitingMs, item.progressAt + responseAlertMs].filter(
			(at) => at > now,
		),
	);
	return future.length ? Math.min(...future) : undefined;
}

/** Pure transition: no transport, read acknowledgment, or approval side effects. */
export function reconcileResponseEpisode(
	previous: ResponseEpisode | undefined,
	input: {
		owner: string;
		nonce: string;
		id: string;
		now: number;
		suspended: boolean;
		observations: ResponseObservation[];
		reset?: boolean;
		diagnostic?: ResponseEpisode['diagnostic'];
	},
): ResponseEpisode {
	const { owner, nonce, now, suspended, observations } = input;
	if (new Set(observations.map((item) => item.id)).size !== observations.length)
		throw new Error('Duplicate response expectation.');
	const prior = previous?.owner === owner && previous.nonce === nonce ? previous : undefined;
	const present = new Set(observations.map((item) => item.id));
	const cohort = prior?.episodeTargets.length
		? prior.episodeTargets
		: (prior?.expectations.map((item) => item.id) ?? []);
	const remaining = cohort.filter((id) => present.has(id));
	const continuing = remaining.length > 0;
	const reset =
		!!input.reset || (!!prior && ((prior.suspended && !suspended) || now < prior.updatedAt));
	const old = new Map(prior?.expectations.map((item) => [item.id, item]));
	const expectations = observations.map((item) => {
		const existing = old.get(item.id);
		return {
			...item,
			startedAt: input.reset ? now : Math.min(existing?.startedAt ?? now, now),
			progressAt:
				!existing || reset || item.progress > existing.progress ? now : existing.progressAt,
		};
	});
	const expired = expectations.filter((item) => now - item.progressAt >= responseAlertMs);
	const retainAlert = continuing && !!prior?.alerted && !reset;
	return responseEpisodeSchema.parse({
		version: 1,
		owner,
		nonce,
		id: prior && (continuing || !observations.length) ? prior.id : input.id,
		updatedAt: now,
		suspended,
		diagnostic: input.diagnostic ?? prior?.diagnostic ?? 'none',
		dismissed: continuing && !!prior?.dismissed,
		episodeTargets:
			retainAlert || (continuing && prior?.dismissed)
				? remaining
				: !suspended
					? expired.map((item) => item.id)
					: [],
		alerted: expectations.length > 0 && (retainAlert || (!suspended && expired.length > 0)),
		expectations,
	});
}

export function responseEpisodePhase(episode: ResponseEpisode, now: number) {
	if (!episode.expectations.length) return 'clear';
	if (episode.suspended) return 'suspended';
	if (episode.dismissed) return 'dismissed';
	// Retain the episode for relay deduplication, but display only a currently overdue wait.
	if (
		episode.alerted &&
		episode.expectations.some((item) => now - item.progressAt >= responseAlertMs)
	)
		return 'attention';
	return episode.expectations.some((item) => now - item.progressAt >= responseWaitingMs)
		? 'waiting'
		: 'observing';
}
