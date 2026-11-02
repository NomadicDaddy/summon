import { join } from 'node:path';
import { z } from 'zod';

import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { noticesHeldPrefix, runtimePath } from './mail-session.ts';

const schema = z
	.object({
		version: z.literal(1),
		nonce: z.string().regex(/^[a-z0-9-]+$/i),
		thread: z.string().min(1).max(128),
		phase: z.enum(['unknown', 'busy', 'idle']),
		since: z.number().int().nonnegative(),
		bootstrapUsed: z.boolean(),
		generation: z.number().int().nonnegative(),
	})
	.strict();
const pathFor = (name: string, nonce: string): string => {
	ownMailbox(name);
	if (!/^[a-z0-9-]+$/i.test(nonce)) throw new Error('Invalid launch nonce.');
	return join(runtimePath(name), `${nonce}.grok-turn`);
};

export async function grokTurn(name: string, nonce: string) {
	const raw = await optionalText(pathFor(name, nonce));
	if (raw === undefined) return undefined;
	try {
		const state = schema.parse(JSON.parse(raw) as unknown);
		if (state.nonce === nonce) return state;
	} catch {
		/* Never echo hook input or persisted conversation data. */
	}
	throw new Error('Invalid Grok turn observation; notices remain queued.');
}

export async function initializeGrokTurn(
	name: string,
	nonce: string,
	thread: string,
): Promise<void> {
	const path = pathFor(name, nonce);
	await locked(`${path}.lock`, async () => {
		const current = await grokTurn(name, nonce);
		if (current) {
			if (current.thread !== thread) throw new Error('Grok turn belongs to another thread.');
			return;
		}
		await atomicWrite(
			path,
			JSON.stringify(
				schema.parse({
					version: 1,
					nonce,
					thread,
					phase: 'unknown',
					since: Date.now(),
					bootstrapUsed: false,
					generation: 0,
				}),
			),
		);
	});
}

/** Readiness gets one bootstrap wake; ordinary wakes require the provider's idle observation. */
export async function grokNoticeAllowed(name: string, nonce: string): Promise<boolean> {
	const state = await grokTurn(name, nonce);
	const ready = await optionalText(join(runtimePath(name), `${nonce}.ready`));
	return !!state && (state.phase === 'idle' || (!state.bootstrapUsed && ready !== nonce));
}

/** Reports the existing native gate; no timeout, guessed idle or draft-clearing advice. */
export async function grokNoticeHold(name: string, nonce: string): Promise<string | undefined> {
	const held = `${noticesHeldPrefix}${name} launch ${nonce}:`;
	const state = await grokTurn(name, nonce);
	if (!state) return `${held} it has no Grok turn record, so completion cannot be observed.`;
	const ready = await optionalText(join(runtimePath(name), `${nonce}.ready`));
	if (state.phase === 'idle' || (!state.bootstrapUsed && ready !== nonce)) return undefined;
	if (state.phase === 'busy')
		return `${held} its Grok turn is recorded as busy; waiting for Grok's native idle prompt.`;
	return `${held} Grok's turn state is unknown; waiting for its native idle prompt.`;
}

/** Reserve before input: another arrival cannot create a second queued provider turn. */
export async function reserveGrokNotice(name: string, nonce: string): Promise<() => Promise<void>> {
	const path = pathFor(name, nonce);
	return locked(`${path}.lock`, async () => {
		const state = await grokTurn(name, nonce);
		if (!state || !(await grokNoticeAllowed(name, nonce)))
			throw new Error('Grok is awaiting verified turn completion.');
		await atomicWrite(
			path,
			JSON.stringify({
				...state,
				phase: 'busy',
				since: Date.now(),
				bootstrapUsed: true,
				generation: state.generation + 1,
			}),
		);
		return async () => {
			await locked(`${path}.lock`, async () => {
				const current = await grokTurn(name, nonce);
				if (current?.generation === state.generation + 1)
					await atomicWrite(path, JSON.stringify(state));
			});
		};
	});
}

export async function grokInputSubmitted(name: string, nonce: string): Promise<void> {
	const path = pathFor(name, nonce);
	await locked(`${path}.lock`, async () => {
		const state = await grokTurn(name, nonce);
		if (state)
			await atomicWrite(
				path,
				JSON.stringify({
					...state,
					phase: 'busy',
					since: Date.now(),
					generation: state.generation + 1,
				}),
			);
	});
}

/** Stop can block and continue. Only native idle_prompt is completion evidence for this gate. */
export async function observeGrokTurn(name: string, nonce: string, input: unknown): Promise<void> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return;
	const event = input as Record<string, unknown>;
	if (event.subagentType !== undefined) return;
	const path = pathFor(name, nonce);
	// An obsolete hook must not recreate a removed runtime tree just to discover missing state.
	const observed = await grokTurn(name, nonce);
	if (!observed || event.sessionId !== observed.thread) return;
	await locked(`${path}.lock`, async () => {
		const state = await grokTurn(name, nonce);
		if (!state || event.sessionId !== state.thread) return;
		const busy = ['UserPromptSubmit', 'PreToolUse'].includes(String(event.hook_event_name));
		const idle =
			event.hook_event_name === 'Notification' && event.notificationType === 'idle_prompt';
		if (!busy && !idle) return;
		const at = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : Number.NaN;
		if (
			!Number.isSafeInteger(at) ||
			at < state.since ||
			(idle && at === state.since) ||
			at > Date.now()
		)
			return;
		await atomicWrite(
			path,
			JSON.stringify({
				...state,
				phase: busy ? 'busy' : 'idle',
				since: at,
				generation: state.generation + 1,
			}),
		);
	});
}
