import { join } from 'node:path';
import { z } from 'zod';

import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { noticesHeldPrefix, runtimePath } from './mail-session.ts';

/**
 * Version 2 adds the launch's startup outcome (Phillip #22057 on #22056). `none` until kiloStartup
 * marks its startup input `submitting`, just before the prompt_async POST; then `accepted` (2xx) or
 * `uncertain` (any other result, which can't prove Kilo took no turn). Version 1 records are
 * refused, never translated: those seats keep notices queued until relaunched.
 */
const schema = z
	.object({
		version: z.literal(2),
		nonce: z.string().regex(/^[a-z0-9-]+$/i),
		thread: z.string().min(1).max(128),
		observer: z.string().min(1).max(128).nullable(),
		phase: z.enum(['unknown', 'busy', 'idle']),
		busyObserved: z.boolean(),
		bootstrapUsed: z.boolean(),
		startup: z.enum(['none', 'submitting', 'accepted', 'uncertain']),
		generation: z.number().int().nonnegative(),
	})
	.strict();
type KiloTurn = z.infer<typeof schema>;

function pathFor(name: string, nonce: string): string {
	ownMailbox(name);
	if (!/^[a-z0-9-]+$/i.test(nonce)) throw new Error('Invalid launch nonce.');
	return join(runtimePath(name), `${nonce}.kilo-turn`);
}

export async function kiloTurn(name: string, nonce: string): Promise<KiloTurn | undefined> {
	const raw = await optionalText(pathFor(name, nonce));
	if (raw === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
		const state = schema.parse(value);
		if (state.nonce === nonce) return state;
	} catch {
		/* Persist only scoped observation metadata; never echo provider event payloads. */
	}
	if ((value as { version?: unknown } | null)?.version === 1)
		throw new Error(
			'Kilo turn record is version 1, from before notice ordering; notices remain queued until this seat is relaunched.',
		);
	throw new Error('Invalid Kilo turn observation; notices remain queued.');
}

/** Receiver attachment preserves observations; a new stream cannot inherit old idle. */
export async function initializeKiloTurn(
	name: string,
	nonce: string,
	thread: string,
	observer?: string,
): Promise<void> {
	const path = pathFor(name, nonce);
	await locked(`${path}.lock`, async () => {
		const current = await kiloTurn(name, nonce);
		if (current && current.thread !== thread)
			throw new Error('Kilo turn belongs to another thread.');
		if (current && observer === undefined) return;
		await atomicWrite(
			path,
			JSON.stringify(
				schema.parse({
					version: 2,
					nonce,
					thread,
					observer: observer ?? null,
					phase: 'unknown',
					busyObserved: false,
					bootstrapUsed: current?.bootstrapUsed ?? false,
					startup: current?.startup ?? 'none',
					generation: (current?.generation ?? 0) + 1,
				}),
			),
		);
	});
}

/**
 * kiloStartup marks its startup input just before the POST. Anything observed before this is
 * discarded, so only a busy then idle seen after it can complete the startup turn.
 */
export async function kiloStartupSubmitting(
	name: string,
	nonce: string,
	thread: string,
): Promise<void> {
	const path = pathFor(name, nonce);
	await locked(`${path}.lock`, async () => {
		const state = await kiloTurn(name, nonce);
		if (!state || state.thread !== thread || state.startup !== 'none') return;
		await atomicWrite(
			path,
			JSON.stringify({
				...state,
				startup: 'submitting',
				phase: 'unknown',
				busyObserved: false,
				generation: state.generation + 1,
			}),
		);
	});
}

/**
 * The POST's outcome. Phase and busyObserved are kept exactly: a fast turn can go busy and idle
 * before the response, and that completion must still count (Morgan 5f28e29a).
 */
export async function kiloStartupSettled(
	name: string,
	nonce: string,
	thread: string,
	outcome: 'accepted' | 'uncertain',
): Promise<void> {
	const path = pathFor(name, nonce);
	await locked(`${path}.lock`, async () => {
		const state = await kiloTurn(name, nonce);
		if (!state || state.thread !== thread || state.startup !== 'submitting') return;
		await atomicWrite(
			path,
			JSON.stringify({ ...state, startup: outcome, generation: state.generation + 1 }),
		);
	});
}

/**
 * A notice is typed only after an observed busy then idle following the startup input, once its
 * outcome is settled. There is no pre-idle fallback: an unobservable seat keeps its notices queued
 * (Phillip #22057 on #22056; design .aidd/reports/carl/kilo-bootstrap-ordering-proposal-20261024-r3.md).
 */
export async function kiloNoticeAllowed(name: string, nonce: string): Promise<boolean> {
	const state = await kiloTurn(name, nonce);
	return (
		!!state &&
		(state.startup === 'accepted' || state.startup === 'uncertain') &&
		state.phase === 'idle'
	);
}

const observationLost =
	'In the seat, summon --checkpoint collects queued work but does not restore observation; only an operator relaunch does.';

/**
 * Why notices are held, for the seat's delivery status (Roger M1, Morticia L1 on 8a3ffce). Observed
 * state only, with no timeout and no guessed cause. A lost stream is reported before the startup
 * wait; nothing is reported while startup is pending on an attached stream, or while a turn is busy.
 * Version 1 and invalid records still throw, as kiloTurn does.
 */
export async function kiloNoticeHold(name: string, nonce: string): Promise<string | undefined> {
	const held = `${noticesHeldPrefix}${name} launch ${nonce}:`;
	const state = await kiloTurn(name, nonce);
	if (!state)
		return `${held} it has no Kilo turn record, so turn completion cannot be observed. ${observationLost}`;
	if (state.observer === null)
		return `${held} no Kilo turn stream is attached, so turn completion cannot be observed. ${observationLost}`;
	if (state.startup === 'none' || state.startup === 'submitting' || state.phase !== 'unknown')
		return undefined;
	return `${held} waiting for an observed busy then idle on its Kilo turn stream (startup ${state.startup}). If the seat is idle, summon --checkpoint in it collects queued work.`;
}

/** Reserve before writing. A repeated idle event cannot release this reservation. */
export async function reserveKiloNotice(name: string, nonce: string): Promise<() => Promise<void>> {
	const path = pathFor(name, nonce);
	return locked(`${path}.lock`, async () => {
		const state = await kiloTurn(name, nonce);
		if (!state || !(await kiloNoticeAllowed(name, nonce)))
			throw new Error('Kilo is awaiting verified turn completion.');
		await atomicWrite(
			path,
			JSON.stringify({
				...state,
				phase: 'busy',
				busyObserved: false,
				bootstrapUsed: true,
				generation: state.generation + 1,
			}),
		);
		return async () => {
			await locked(`${path}.lock`, async () => {
				const current = await kiloTurn(name, nonce);
				if (current?.generation === state.generation + 1)
					await atomicWrite(path, JSON.stringify(state));
			});
		};
	});
}

export async function kiloInputSubmitted(name: string, nonce: string): Promise<void> {
	const path = pathFor(name, nonce);
	await locked(`${path}.lock`, async () => {
		const state = await kiloTurn(name, nonce);
		if (state)
			await atomicWrite(
				path,
				JSON.stringify({
					...state,
					phase: 'busy',
					busyObserved: false,
					generation: state.generation + 1,
				}),
			);
	});
}

export async function invalidateKiloTurn(
	name: string,
	nonce: string,
	observer: string,
): Promise<void> {
	const path = pathFor(name, nonce);
	await locked(`${path}.lock`, async () => {
		const state = await kiloTurn(name, nonce);
		// A null observer records the loss; no event can match it, and a reattach names a new one.
		if (state?.observer === observer)
			await atomicWrite(
				path,
				JSON.stringify({
					...state,
					observer: null,
					phase: 'unknown',
					busyObserved: false,
					generation: state.generation + 1,
				}),
			);
	});
}

/** The ordered, authenticated owned-server stream is authoritative, never a sidebar status. */
export async function observeKiloTurn(
	name: string,
	nonce: string,
	observer: string,
	input: unknown,
): Promise<void> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return;
	const event = input as Record<string, unknown>;
	if (
		!event.properties ||
		typeof event.properties !== 'object' ||
		Array.isArray(event.properties)
	)
		return;
	const properties = event.properties as Record<string, unknown>;
	if (event.type !== 'session.status') return;
	const status =
		properties.status && typeof properties.status === 'object'
			? (properties.status as Record<string, unknown>).type
			: undefined;
	const path = pathFor(name, nonce);
	await locked(`${path}.lock`, async () => {
		const state = await kiloTurn(name, nonce);
		if (!state || state.observer !== observer || state.thread !== properties.sessionID) return;
		// Before the startup input is marked, nothing observed belongs to it.
		if (state.startup === 'none') return;
		// Native busy must be observed after reservation: duplicate completion cannot queue two turns.
		if (status === 'idle' && !state.busyObserved) return;
		await atomicWrite(
			path,
			JSON.stringify({
				...state,
				phase:
					status === 'idle'
						? 'idle'
						: ['busy', 'retry'].includes(String(status))
							? 'busy'
							: 'unknown',
				busyObserved: status === 'busy' || status === 'retry',
				generation: state.generation + 1,
			}),
		);
	});
}
