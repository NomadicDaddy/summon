import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

import { readActivity } from './agent-activity.ts';
import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { runtimePath } from './mail-session.ts';
import { NotificationNotSentError } from './notification-delivery.ts';

const stageSchema = z.enum([
	'mention wake',
	'pending wake',
	'rest wake',
	'hibernation control',
	'receiver initialization',
	'receiver cycle',
	'unsubmitted notice',
	'mail inventory',
	'room inventory',
	'telegram inventory',
	'approval inventory',
	'checkpoint inventory',
]);
const nonceSchema = z
	.string()
	.regex(/^[a-z0-9-]+$/i)
	.nullable();
const episodeSchema = z
	.object({
		id: z.uuid(),
		owner: z.string(),
		stage: stageSchema,
		observedNonce: nonceSchema,
		roomThrough: z.number().int().nonnegative().nullable(),
		certainty: z.enum(['not-sent', 'uncertain']),
		reason: z.enum([
			'No provider input was sent.',
			'Provider input may have begun; inspect before retrying.',
		]),
		failedAt: z.iso.datetime(),
		recoveredAt: z.iso.datetime().optional(),
		recoveredByNonce: nonceSchema.optional(),
	})
	.strict();
const indexSchema = z.partialRecord(stageSchema, z.uuid());
export type WakeStage = z.infer<typeof stageSchema>;
export type WakeErrorEpisode = z.infer<typeof episodeSchema>;
const indexPath = (name: string): string => join(runtimePath(name), 'wake-errors.json');
const episodePath = (name: string, id: string): string =>
	join(runtimePath(name), 'wake-errors', `${z.uuid().parse(id)}.json`);

async function index(name: string): Promise<z.infer<typeof indexSchema>> {
	ownMailbox(name);
	const raw = await optionalText(indexPath(name));
	if (raw === undefined) return {};
	try {
		return indexSchema.parse(JSON.parse(raw) as unknown);
	} catch {
		throw new Error('Invalid wake error index; no recovery was recorded.');
	}
}

async function episode(name: string, id: string, stage: WakeStage): Promise<WakeErrorEpisode> {
	try {
		const raw = await optionalText(episodePath(name, id));
		const value = episodeSchema.parse(JSON.parse(raw ?? '') as unknown);
		if (value.owner === name && value.id === id && value.stage === stage) return value;
	} catch {
		/* Persisted content is never included in the diagnostic. */
	}
	throw new Error('Invalid wake error episode; no recovery was recorded.');
}

async function currentNonce(name: string): Promise<string | null> {
	const value = await readActivity(name).catch(() => undefined);
	return value && /^[a-z0-9-]+$/i.test(value.nonce) ? value.nonce : null;
}

/** Own status is an inspection consumer, never an acknowledgment or retry command. */
export async function wakeErrors(name: string): Promise<WakeErrorEpisode[]> {
	const entries = await index(name);
	return Promise.all(
		Object.entries(entries).map(([stage, id]) => episode(name, id, stageSchema.parse(stage))),
	);
}

/** Retain each episode before an operator-visible report; raw error bodies are not persisted. */
export async function retainWakeError(
	name: string,
	stage: WakeStage,
	error: unknown,
	roomThrough: number | null = null,
): Promise<{ episode: WakeErrorEpisode; changed: boolean }> {
	ownMailbox(name);
	stageSchema.parse(stage);
	z.number().int().nonnegative().nullable().parse(roomThrough);
	return locked(`${indexPath(name)}.lock`, async () => {
		const entries = await index(name);
		const previous = entries[stage] ? await episode(name, entries[stage], stage) : undefined;
		const observedNonce = await currentNonce(name);
		const certainty = error instanceof NotificationNotSentError ? 'not-sent' : 'uncertain';
		if (
			previous &&
			!previous.recoveredAt &&
			previous.observedNonce === observedNonce &&
			previous.roomThrough === roomThrough &&
			previous.certainty === certainty
		)
			return { episode: previous, changed: false };
		const value: WakeErrorEpisode = {
			id: randomUUID(),
			owner: name,
			stage,
			observedNonce,
			roomThrough,
			certainty,
			reason:
				certainty === 'not-sent'
					? 'No provider input was sent.'
					: 'Provider input may have begun; inspect before retrying.',
			failedAt: new Date().toISOString(),
		};
		await atomicWrite(episodePath(name, value.id), JSON.stringify(value));
		await atomicWrite(indexPath(name), JSON.stringify({ ...entries, [stage]: value.id }));
		return { episode: value, changed: true };
	});
}

/** Call only after a successful operation or its exact target was acknowledged, never on a pause. */
export async function recoverWakeError(name: string, stage: WakeStage): Promise<void> {
	ownMailbox(name);
	stageSchema.parse(stage);
	await locked(`${indexPath(name)}.lock`, async () => {
		const id = (await index(name))[stage];
		if (!id) return;
		const previous = await episode(name, id, stage);
		if (previous.recoveredAt) return;
		await atomicWrite(
			episodePath(name, id),
			JSON.stringify({
				...previous,
				recoveredAt: new Date().toISOString(),
				recoveredByNonce: await currentNonce(name),
			}),
		);
	});
}
