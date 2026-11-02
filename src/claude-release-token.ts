import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * One reservation's authority to undo itself when Summon withholds its own Enter before writing
 * it. A random token, never the record generation: an older rollback can restore a generation, so
 * only the reservation that minted this token can spend it. Native draft reports prove, in order,
 * that Claude saw the pasted text and then an empty box.
 */
export const releaseTokenSchema = z
	.object({
		token: z.uuid(),
		nonce: z.string().min(1),
		observer: z.string().min(1).max(128),
		epoch: z.number().int().positive(),
		sawText: z.boolean(),
		sawEmpty: z.boolean(),
	})
	.strict();

export type ReleaseToken = z.infer<typeof releaseTokenSchema>;

type Holds = { release?: ReleaseToken | undefined };

interface Releasable extends Holds {
	nonce: string;
	observer: string;
	epoch: number;
}

/** The terminal path's reservation carries a fresh token; every other reserve writes none. */
export function releaseFor<T extends Releasable>(state: T, releasable: boolean): T {
	if (!releasable) return state;
	const release: ReleaseToken = {
		token: randomUUID(),
		nonce: state.nonce,
		observer: state.observer,
		epoch: state.epoch,
		sawText: false,
		sawEmpty: false,
	};
	return { ...state, release };
}

/** Every write except an ordered native draft or idle report spends the token. */
export function withoutRelease<T extends Holds>(state: T): T {
	const next = { ...state };
	delete next.release;
	return next;
}

/** Later text cancels an earlier empty proof; only text and then empty, in order, counts. */
export function observedRelease<T extends Holds>(
	state: T,
	kind: string,
	draft: boolean,
	ordered: boolean,
): T {
	if (!state.release) return { ...state };
	if (!ordered || (kind !== 'draft' && kind !== 'idle')) return withoutRelease(state);
	if (kind === 'idle') return { ...state };
	const release = draft
		? { ...state.release, sawText: true, sawEmpty: false }
		: { ...state.release, sawEmpty: state.release.sawText };
	return { ...state, release };
}
