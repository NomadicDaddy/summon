import { join } from 'node:path';
import { z } from 'zod';

import { readActivity } from './agent-activity.ts';
import { atomicWrite, optionalText } from './mail-files.ts';
import { runtimePath } from './mail-session.ts';
import { metadataText } from './model-info.ts';

const modelSchema = z.object({ id: z.string(), providerID: z.string() });
const sessionSchema = z.object({
	id: z.string(),
	model: modelSchema,
	time: z.object({ updated: z.number() }),
});
const storedSchema = z.object({
	sessionId: z.string(),
	model: z.string(),
	contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
const pathFor = (name: string, nonce: string) => join(runtimePath(name), `${nonce}.kilo-model`);

/** Reads only the already owned worker. Credentials never leave the caller's request memory. */
export async function captureKiloModel(
	base: string,
	query: string,
	headers: Record<string, string>,
	signal: AbortSignal,
	launch: { name: string; nonce: string },
	sessionId: string,
): Promise<void> {
	const read = async (path: string): Promise<unknown> => {
		const response = await fetch(`${base}${path}${query}`, {
			headers,
			redirect: 'error',
			signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
		});
		if (!response.ok) throw new Error('Kilo model metadata unavailable.');
		return response.json();
	};
	const path = `/session/${encodeURIComponent(sessionId)}`;
	const before = sessionSchema.parse(await read(path));
	if (before.id !== sessionId) return;
	const catalog = z
		.object({
			all: z.array(
				z.object({
					id: z.string(),
					models: z.record(
						z.string(),
						z.object({ limit: z.object({ context: z.number() }) }),
					),
				}),
			),
		})
		.parse(await read('/provider'));
	const contextWindow = catalog.all.find((item) => item.id === before.model.providerID)?.models[
		before.model.id
	]?.limit.context;
	const after = sessionSchema.parse(await read(path));
	if (
		after.id !== sessionId ||
		after.model.id !== before.model.id ||
		after.model.providerID !== before.model.providerID ||
		after.time.updated !== before.time.updated
	)
		return;
	const model = metadataText(`${after.model.providerID}/${after.model.id}`);
	if (!model || signal.aborted || (await readActivity(launch.name))?.nonce !== launch.nonce)
		return;
	await atomicWrite(
		pathFor(launch.name, launch.nonce),
		JSON.stringify({
			sessionId,
			model,
			...(Number.isSafeInteger(contextWindow) && contextWindow && contextWindow > 0
				? { contextWindow }
				: {}),
		}),
	);
}

export async function readKiloCapacity(name: string, sessionId: string, model: string) {
	const active = await readActivity(name);
	if (!active || !/^[a-z0-9-]+$/i.test(active.nonce)) return undefined;
	const raw = await optionalText(pathFor(name, active.nonce));
	if (!raw) return undefined;
	const stored = storedSchema.parse(JSON.parse(raw) as unknown);
	return stored.sessionId === sessionId &&
		stored.model === model &&
		(await readActivity(name))?.nonce === active.nonce
		? stored.contextWindow
		: undefined;
}
