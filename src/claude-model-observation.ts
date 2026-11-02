import { join } from 'node:path';
import { z } from 'zod';

import type { ModelInfo } from './model-info.ts';

import { readActivity } from './agent-activity.ts';
import { claudeTurn } from './claude-turn-state.ts';
import { atomicWrite, optionalText } from './mail-files.ts';
import { runtimePath } from './mail-session.ts';
import { metadataText } from './model-info.ts';

const schema = z
	.object({
		session: z.string().min(1).max(128),
		epoch: z.number().int().positive(),
		model: z.string().refine((value) => metadataText(value) !== undefined),
		contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	})
	.strict();
const stored = schema.extend({ observer: z.string(), observedAt: z.iso.datetime() });
const pathFor = (name: string, nonce: string) => join(runtimePath(name), `${nonce}.claude-model`);

/** Called only inside the authenticated bridge's ordered queue. Contains no usage or content. */
export async function observeClaudeModel(
	name: string,
	nonce: string,
	observer: string,
	input: unknown,
): Promise<void> {
	const event = schema.parse(input);
	const state = await claudeTurn(name, nonce);
	if (
		!state?.attached ||
		state.observer !== observer ||
		state.epoch !== event.epoch ||
		state.thread !== event.session
	)
		throw new Error('Claude model observation belongs to another attachment.');
	await atomicWrite(
		pathFor(name, nonce),
		JSON.stringify({ ...event, observer, observedAt: new Date().toISOString() }),
	);
}

export async function readClaudeModel(
	name: string,
	sessionId: string,
): Promise<ModelInfo | undefined> {
	const active = await readActivity(name);
	if (!active || !/^[a-z0-9-]+$/i.test(active.nonce)) return undefined;
	const state = await claudeTurn(name, active.nonce);
	if (!state?.attached || state.thread !== sessionId) return undefined;
	const raw = await optionalText(pathFor(name, active.nonce));
	if (!raw) return undefined;
	const record = stored.parse(JSON.parse(raw) as unknown);
	const current = await claudeTurn(name, active.nonce);
	if (
		record.session !== sessionId ||
		record.observer !== state.observer ||
		record.epoch !== state.epoch ||
		!current?.attached ||
		current.epoch !== state.epoch ||
		current.observer !== state.observer ||
		(await readActivity(name))?.nonce !== active.nonce
	)
		return undefined;
	return {
		provider: 'claude',
		sessionId,
		model: record.model,
		contextWindow: record.contextWindow,
		observedAt: record.observedAt,
	};
}
