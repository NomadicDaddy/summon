import { join } from 'node:path';
import { z } from 'zod';

import {
	observedRelease,
	releaseFor,
	releaseTokenSchema,
	withoutRelease,
} from './claude-release-token.ts';
import { traceEvent, traceSwap } from './claude-turn-trace.ts';
import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { runtimePath } from './mail-session.ts';

const schema = z
	.object({
		version: z.literal(2),
		nonce: z.string().regex(/^[a-z0-9-]+$/i),
		thread: z.string().min(1).max(128),
		observer: z.string().min(1).max(128),
		epoch: z.number().int().positive(),
		sequence: z.number().int().nonnegative(),
		generation: z.number().int().nonnegative(),
		phase: z.enum(['unknown', 'busy', 'idle']),
		turn: z.string().min(1).max(128).nullable(),
		draft: z.boolean(),
		attached: z.boolean(),
		compactions: z.number().int().nonnegative(),
		release: releaseTokenSchema.optional(),
	})
	.strict();

export const claudeTurnEventSchema = z
	.object({
		session: z.string().min(1).max(128),
		epoch: z.number().int().positive(),
		sequence: z.number().int().positive(),
		kind: z.enum([
			'attach',
			'start',
			'complete',
			'draft',
			'submit',
			'compact-start',
			'compact-end',
			'end',
			'unknown',
			'idle',
		]),
		turn: z.string().min(1).max(128).nullable(),
		draft: z.boolean(),
		completed: z.boolean(),
	})
	.strict();

export function pathFor(name: string, nonce: string): string {
	ownMailbox(name);
	if (!/^[a-z0-9-]+$/i.test(nonce)) throw new Error('Invalid launch nonce.');
	return join(runtimePath(name), `${nonce}.claude-turn`);
}

export async function claudeTurn(name: string, nonce: string) {
	const raw = await optionalText(pathFor(name, nonce));
	if (raw === undefined) return undefined;
	try {
		const state = schema.parse(JSON.parse(raw) as unknown);
		if (state.nonce === nonce) return state;
	} catch {
		/* Never echo provider payloads or metadata-file contents. */
	}
	throw new Error('Invalid Claude turn observation; notices remain queued.');
}

export async function initializeClaudeTurn(
	name: string,
	nonce: string,
	thread: string,
	observer?: string,
): Promise<void> {
	const path = pathFor(name, nonce);
	await locked(`${path}.lock`, async () => {
		const current = await claudeTurn(name, nonce);
		if (current && current.thread !== thread)
			throw new Error('Claude turn belongs to another thread.');
		if (current && observer === undefined) return;
		if (observer === undefined) return;
		const next = schema.parse({
			version: 2,
			nonce,
			thread,
			observer,
			epoch: (current?.epoch ?? 0) + 1,
			sequence: 0,
			generation: (current?.generation ?? 0) + 1,
			phase: 'unknown',
			turn: null,
			draft: true,
			attached: false,
			compactions: 0,
		});
		await atomicWrite(path, JSON.stringify(next));
		await traceSwap(
			path,
			'initialize',
			current,
			next,
			`observer issued at epoch ${next.epoch}`,
		);
	});
}

/** An authenticated module attachment withdraws prior idle before its core can start. */
export async function attachClaudeObserver(
	name: string,
	nonce: string,
	observer: string,
	thread: string,
): Promise<number> {
	const path = pathFor(name, nonce);
	return locked(`${path}.lock`, async () => {
		const state = await claudeTurn(name, nonce);
		if (!state || state.observer !== observer || state.thread !== thread)
			throw new Error('Claude attachment belongs to another observer or session.');
		const epoch = state.epoch + 1;
		const next = {
			...withoutRelease(state),
			epoch,
			sequence: 0,
			generation: state.generation + 1,
			phase: 'unknown' as const,
			turn: null,
			attached: true,
			draft: true,
			compactions: 0,
		};
		await atomicWrite(path, JSON.stringify(next));
		await traceSwap(path, 'attach-observer', state, next, `attached at epoch ${epoch}`);
		return epoch;
	});
}

export async function claudeNoticeAllowed(name: string, nonce: string): Promise<boolean> {
	const state = await claudeTurn(name, nonce);
	return (
		!!state &&
		state.attached &&
		state.phase === 'idle' &&
		!state.draft &&
		state.compactions === 0
	);
}

/** The rollback undoes an unsent notice; only the Window's terminal path mints a release token. */
export async function reserveClaudeNotice(
	name: string,
	nonce: string,
	releasable = false,
): Promise<(() => Promise<void>) & { token?: string | undefined }> {
	const path = pathFor(name, nonce);
	return locked(`${path}.lock`, async () => {
		const found = await claudeTurn(name, nonce);
		if (!found || !(await claudeNoticeAllowed(name, nonce)))
			throw new Error('Claude is awaiting verified turn completion or a clear draft.');
		const state = withoutRelease(found);
		const reserved = { ...releaseFor(state, releasable), phase: 'busy' as const, turn: null };
		await atomicWrite(path, JSON.stringify({ ...reserved, generation: state.generation + 1 }));
		await traceSwap(path, 'notice-reserve', state, reserved, 'busy until native start');
		const rollback = async (): Promise<void> => {
			await locked(`${path}.lock`, async () => {
				const current = await claudeTurn(name, nonce);
				if (current?.generation !== state.generation + 1) return;
				await atomicWrite(path, JSON.stringify(state));
				await traceSwap(
					path,
					'notice-restore',
					current,
					state,
					'unsent notice rolled back',
				);
			});
		};
		return Object.assign(rollback, { token: reserved.release?.token });
	});
}

/** Physical human submission cancels prior completion authority before Enter is written. */
export async function claudeInputSubmitted(name: string, nonce: string): Promise<void> {
	const path = pathFor(name, nonce);
	await locked(`${path}.lock`, async () => {
		const state = await claudeTurn(name, nonce);
		if (!state) return;
		const submitted = { ...withoutRelease(state), phase: 'busy' as const, turn: null };
		await atomicWrite(path, JSON.stringify({ ...submitted, generation: state.generation + 1 }));
		await traceSwap(path, 'human-submit', state, submitted, 'busy until native start');
	});
}

export async function invalidateClaudeTurn(
	name: string,
	nonce: string,
	observer: string,
): Promise<void> {
	const path = pathFor(name, nonce);
	await locked(`${path}.lock`, async () => {
		const state = await claudeTurn(name, nonce);
		if (state?.observer !== observer) return;
		const next = {
			...withoutRelease(state),
			phase: 'unknown' as const,
			turn: null,
			attached: false,
			draft: true,
		};
		await atomicWrite(path, JSON.stringify({ ...next, generation: state.generation + 1 }));
		await traceSwap(
			path,
			'invalidate',
			state,
			next,
			'observation lost; detached until reattached',
		);
	});
}

/** Only the owned authenticated bridge supplies this ordered metadata, never an agent status. */
export async function observeClaudeTurn(
	name: string,
	nonce: string,
	observer: string,
	input: unknown,
): Promise<void> {
	const event = claudeTurnEventSchema.parse(input);
	const path = pathFor(name, nonce);
	await locked(`${path}.lock`, async () => {
		const state = await claudeTurn(name, nonce);
		if (!state || state.observer !== observer) return;
		if (event.session !== state.thread)
			throw new Error('Claude observation belongs to another session.');
		if (event.epoch < state.epoch)
			return traceEvent(path, event, state, state, 'ignored: older attachment epoch');
		if (event.epoch > state.epoch)
			throw new Error('Claude observation has an unissued attachment generation.');
		if (event.sequence <= state.sequence)
			return traceEvent(path, event, state, state, 'ignored: repeated sequence');
		const ordered = event.sequence === state.sequence + 1;
		const next = {
			...observedRelease(state, event.kind, event.draft, ordered),
			sequence: event.sequence,
			draft: event.kind === 'idle' ? state.draft : event.draft,
			generation: state.generation + 1,
		};
		if (!ordered || event.kind === 'unknown' || event.kind === 'end') {
			next.phase = 'unknown';
			next.turn = null;
			next.attached = false;
		} else if (event.kind === 'attach') {
			next.phase = 'unknown';
			next.turn = null;
			next.attached = true;
		} else if (state.attached && event.kind === 'start' && event.turn) {
			next.phase = 'busy';
			next.turn = event.turn;
		} else if (
			state.attached &&
			event.kind === 'idle' &&
			state.phase === 'unknown' &&
			state.turn === null &&
			event.turn === null &&
			state.compactions === 0 &&
			!event.draft
		) {
			next.phase = 'idle';
			next.draft = false;
		} else if (event.kind === 'submit') {
			next.phase = 'busy';
			// Only native submission can restore a turn invalidated before physical Enter.
			next.turn = state.attached ? event.turn : null;
		} else if (state.attached && event.kind === 'compact-start') {
			next.compactions++;
		} else if (state.attached && event.kind === 'compact-end') {
			if (state.compactions === 0) {
				next.phase = 'unknown';
				next.attached = false;
			} else next.compactions--;
		} else if (
			state.attached &&
			event.kind === 'complete' &&
			state.turn === event.turn &&
			event.turn
		) {
			next.phase = event.completed ? 'idle' : 'unknown';
			next.turn = null;
		}
		await atomicWrite(path, JSON.stringify(next));
		await traceEvent(path, event, state, next, ordered ? 'ordered' : 'gap');
	});
}
