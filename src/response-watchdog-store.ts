import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

import type { WakeTarget } from './wake-part.ts';

import { checkpointHash } from './checkpoint-package-model.ts';
import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { runtimePath } from './mail-session.ts';
import { createResponseClock } from './response-watchdog-clock.ts';
import { responseFailureView } from './response-watchdog-errors.ts';
import {
	reconcileResponseEpisode,
	responseEpisodePhase,
	responseEpisodeSchema,
	type ResponseObservation,
} from './response-watchdog-model.ts';
import { targetSchema } from './wake-delivery-store.ts';

const stateSchema = z
	.object({
		episode: responseEpisodeSchema,
		retiredEpisodeId: z.uuid().nullable().default(null),
		targets: z.record(z.string(), targetSchema),
		proofs: z
			.record(
				z.string(),
				z.object({ packageId: z.uuid(), page: z.number().int().nonnegative() }).strict(),
			)
			.default({}),
		outcomes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
	})
	.strict();
export type ResponseState = z.infer<typeof stateSchema>;
const path = (name: string) => join(runtimePath(name), 'response-watchdog.json');
const clocks = new Map<string, ReturnType<typeof createResponseClock>>();

class InvalidResponseState extends Error {}

async function readResponseState(name: string): Promise<ResponseState | undefined> {
	ownMailbox(name);
	const raw = await optionalText(path(name));
	if (raw === undefined) return undefined;
	try {
		if (Buffer.byteLength(raw) > 1500000) throw new Error('Oversized');
		const state = stateSchema.parse(JSON.parse(raw) as unknown);
		if (state.episode.owner !== name) throw new Error('Owner mismatch');
		const ids = new Set(state.episode.expectations.map((item) => item.id));
		if (
			ids.size !== state.episode.expectations.length ||
			state.episode.expectations.some(
				(item) =>
					item.startedAt > item.progressAt ||
					item.progressAt > state.episode.updatedAt ||
					(!(item.id in state.targets) && item.condition !== 'inventory'),
			) ||
			Object.entries(state.targets).some(
				([id, target]) => !ids.has(id) || checkpointHash(target) !== id,
			) ||
			Object.keys(state.proofs).some((id) => !(id in state.targets)) ||
			state.episode.episodeTargets.some((id) => !ids.has(id)) ||
			Object.keys(state.outcomes).some((id) => !(id in state.targets))
		)
			throw new Error('Inconsistent response state');
		return state;
	} catch {
		throw new InvalidResponseState('Response watchdog state is invalid; observation restarts.');
	}
}

export async function updateResponseState(
	name: string,
	nonce: string,
	observe: (previous: ResponseState | undefined) => Promise<{
		observations: ResponseObservation[];
		targets: Record<string, WakeTarget>;
		proofs?: ResponseState['proofs'];
		outcomes?: ResponseState['outcomes'];
		suspended: boolean;
	}>,
): Promise<void> {
	ownMailbox(name);
	await locked(`${path(name)}.lock`, async () => {
		let saved: ResponseState | undefined;
		let invalid = false;
		try {
			saved = await readResponseState(name);
		} catch (error: unknown) {
			if (!(error instanceof InvalidResponseState)) throw error;
			invalid = true;
		}
		const previous = saved?.episode.nonce === nonce ? saved : undefined;
		const key = path(name) + ':' + nonce;
		let clock = clocks.get(key);
		if (!clock) {
			clock = createResponseClock();
			if (clocks.size >= 256) clocks.clear();
			clocks.set(key, clock);
		}
		const time = clock(previous?.episode.updatedAt);
		const observation = await observe(previous);
		const episode = reconcileResponseEpisode(previous?.episode, {
			owner: name,
			nonce,
			id: randomUUID(),
			now: time.now,
			reset: invalid || time.reset,
			diagnostic: invalid
				? 'state-reset'
				: time.reset
					? 'clock-reset'
					: (previous?.episode.diagnostic ?? 'none'),
			...observation,
		});
		const value = stateSchema.parse({
			episode,
			// Only a transition from valid retained observations proves the old cohort retired.
			retiredEpisodeId:
				previous && (episode.id !== previous.episode.id || !episode.expectations.length)
					? previous.episode.id
					: (previous?.retiredEpisodeId ?? null),
			targets: observation.targets,
			proofs: observation.proofs ?? previous?.proofs ?? {},
			outcomes: Object.fromEntries(
				Object.entries(observation.outcomes ?? previous?.outcomes ?? {}).filter(
					([id]) => id in observation.targets,
				),
			),
		});
		const raw = JSON.stringify(value);
		if (Buffer.byteLength(raw) > 1500000)
			throw new Error('Response watchdog inventory is oversized.');
		// Do not rewrite on a quiet tick solely to record wall-clock liveness.
		if (
			saved &&
			responseEpisodePhase(saved.episode, saved.episode.updatedAt) ===
				responseEpisodePhase(episode, episode.updatedAt) &&
			checkpointHash({ ...saved, episode: { ...saved.episode, updatedAt: 0 } }) ===
				checkpointHash({ ...value, episode: { ...episode, updatedAt: 0 } })
		)
			return;
		await atomicWrite(path(name), raw);
	});
}

export async function responseStatus(name: string, nonce: string) {
	const state = await readResponseState(name);
	if (!state || state.episode.nonce !== nonce) return null;
	return {
		...state.episode,
		phase: responseEpisodePhase(state.episode, Date.now()),
		targets: state.targets,
		outcomes: state.outcomes,
		retiredEpisodeId: state.retiredEpisodeId,
		controlResponse: 'Unhibernate release response is not tracked.',
	};
}

/** A damaged diagnostic must not hide the rest of mail status or the member snapshot. */
export async function responseStatusView(name: string, nonce: string) {
	const diagnostic = await responseFailureView(name, nonce);
	try {
		return { ...diagnostic, responseWatchdog: await responseStatus(name, nonce) };
	} catch {
		return {
			...diagnostic,
			responseWatchdog: null,
			responseWatchdogError:
				'Delivery response observation unavailable; retained state could not be read.',
		};
	}
}

/** Dismissal affects this exact episode only; never read coverage or approvals. */
export async function dismissResponseEpisode(name: string, nonce: string, id: string) {
	ownMailbox(name);
	await locked(`${path(name)}.lock`, async () => {
		const state = await readResponseState(name);
		if (!state || state.episode.nonce !== nonce || state.episode.id !== id)
			throw new Error('Response episode changed; inspect the current launch.');
		state.episode.dismissed = true;
		await atomicWrite(path(name), JSON.stringify(state));
	});
}
