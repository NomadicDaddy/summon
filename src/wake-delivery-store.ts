import { join } from 'node:path';
import { z } from 'zod';

import type { WakeTarget } from './wake-part.ts';

import { checkpointHash } from './checkpoint-package-model.ts';
import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { runtimePath } from './mail-session.ts';
import { unresolvedWakeIndex, updateWakeIndex } from './wake-delivery-index.ts';
import { wakeFailureProjection } from './wake-failure.ts';
import { wakeTargetRead } from './wake-read-proof.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const targetSchema = z
	.object({
		source: z.enum(['readiness', 'mail', 'holds', 'room', 'telegram']),
		key: z.string().min(1).max(128),
		through: z.number().int().nonnegative(),
		ids: z.array(z.string().max(128)).max(10000),
	})
	.strict()
	.superRefine((target, context) => {
		const valid =
			target.source === 'mail'
				? target.key === 'inbox' &&
					target.through === 0 &&
					target.ids.length > 0 &&
					target.ids.every((id) =>
						/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id),
					)
				: target.source === 'holds'
					? target.key === 'decisions' &&
						target.through === 0 &&
						target.ids.length > 0 &&
						target.ids.every((id) =>
							/^hold:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[a-f0-9]{64}$/.test(
								id,
							),
						)
					: target.ids.length === 0 &&
						(target.source === 'room'
							? target.key === 'local' && target.through > 0
							: target.source === 'telegram'
								? hash.safeParse(target.key).success && target.through > 0
								: /^[a-z0-9-]+$/i.test(target.key) && target.through === 0);
		if (!valid || new Set(target.ids).size !== target.ids.length)
			context.addIssue({ code: 'custom', message: 'Invalid wake source bound.' });
	});
const outcomeSchema = z
	.object({
		version: z.literal(1),
		id: hash,
		owner: z.string().min(1).max(64),
		nonce: z.string().regex(/^[a-z0-9-]+$/i),
		stage: z.literal('notification delivery'),
		targets: z.array(targetSchema).min(1).max(5),
		state: z.enum([
			'attempted',
			'not-sent',
			'uncertain',
			'provider-submitted',
			'acknowledged',
			'suppressed',
		]),
		attempts: z.number().int().nonnegative(),
		retryAt: z.number().int().nonnegative(),
		createdAt: z.iso.datetime(),
		updatedAt: z.iso.datetime(),
		failedAt: z.iso.datetime().optional(),
		lastFailureAt: z.iso.datetime().optional(),
		recoveredAt: z.iso.datetime().optional(),
		submittedBy: hash.optional(),
	})
	.strict();
export type WakeOutcome = z.infer<typeof outcomeSchema>;
const pointerPath = (name: string, nonce: string): string =>
	join(runtimePath(name), `${nonce}.wake-delivery`);
export const outcomePath = (name: string, id: string): string =>
	join(runtimePath(name), 'wake-deliveries', `${hash.parse(id)}.json`);

export function normalized(targets: WakeTarget[]): WakeTarget[] {
	return targets
		.map((target) => ({ ...target, ids: [...target.ids].sort() }))
		.sort((a, b) => a.source.localeCompare(b.source) || a.key.localeCompare(b.key));
}
export async function loadWakeOutcome(
	name: string,
	nonce: string,
	id: string,
): Promise<WakeOutcome | undefined> {
	ownMailbox(name);
	const raw = await optionalText(outcomePath(name, id));
	if (raw === undefined) return undefined;
	try {
		if (Buffer.byteLength(raw) > 1_500_000) throw new Error('Oversized outcome');
		const value = outcomeSchema.parse(JSON.parse(raw) as unknown);
		if (
			value.owner === name &&
			value.nonce === nonce &&
			value.id === id &&
			validIdentity(value)
		)
			return value;
	} catch {
		/* Never include persisted data in diagnostics. */
	}
	throw new Error('Invalid wake delivery outcome; inspect before retrying.');
}
export async function saveWakeOutcome(value: WakeOutcome, latest = true): Promise<void> {
	ownMailbox(value.owner);
	outcomeSchema.parse(value);
	if (!validIdentity(value)) throw new Error('Invalid wake delivery identity.');
	const raw = JSON.stringify(value);
	if (Buffer.byteLength(raw) > 1_500_000)
		throw new Error('Wake delivery inventory exceeds its storage bound.');
	await atomicWrite(outcomePath(value.owner, value.id), raw);
	await updateWakeIndex(
		value.owner,
		{ id: value.id, nonce: value.nonce },
		['attempted', 'not-sent', 'uncertain'].includes(value.state),
	);
	if (latest) await atomicWrite(pointerPath(value.owner, value.nonce), value.id);
}

function validIdentity(value: WakeOutcome): boolean {
	return (
		new Set(value.targets.map((target) => target.source)).size === value.targets.length &&
		checkpointHash([value.owner, value.nonce, normalized(value.targets)]) === value.id &&
		!value.targets.some((target) => target.source === 'readiness' && target.key !== value.nonce)
	);
}

async function unresolvedWakeDeliveries(
	name: string,
	submitted?: WakeOutcome,
): Promise<WakeOutcome[]> {
	const values: WakeOutcome[] = [];
	for (const entry of await unresolvedWakeIndex(name)) {
		await lockedOutcome(name, entry.nonce, entry.id, values, submitted);
	}
	return values;
}

async function lockedOutcome(
	name: string,
	nonce: string,
	id: string,
	values: WakeOutcome[],
	submitted?: WakeOutcome,
): Promise<void> {
	await locked(`${outcomePath(name, id)}.lock`, async () => {
		const value = await loadWakeOutcome(name, nonce, id);
		if (!value) throw new Error('Unresolved wake delivery outcome is missing.');
		if (['attempted', 'not-sent', 'uncertain'].includes(value.state)) {
			if (
				(
					await Promise.all(
						value.targets.map((target) => wakeTargetRead(name, nonce, target)),
					)
				).every(Boolean)
			) {
				value.state = 'acknowledged';
				value.updatedAt = new Date().toISOString();
				value.recoveredAt = value.updatedAt;
				await saveWakeOutcome(value, false);
			} else if (
				value.state === 'not-sent' &&
				submitted?.state === 'provider-submitted' &&
				value.targets.every((target) =>
					submitted.targets.some(
						(next) =>
							target.source === next.source &&
							target.key === next.key &&
							target.through <= next.through &&
							target.ids.every((item) => next.ids.includes(item)),
					),
				)
			) {
				value.state = 'provider-submitted';
				value.submittedBy = submitted.id;
				value.updatedAt = new Date().toISOString();
				value.recoveredAt = value.updatedAt;
				await saveWakeOutcome(value, false);
			} else values.push(value);
		} else await updateWakeIndex(name, { id, nonce }, false);
	});
}

/** Compact own-status evidence; inspection never establishes model receipt. */
export async function wakeDeliveryStatus(name: string, nonce: string) {
	// A diagnostic read never rejects status: an unreadable failure note is simply omitted.
	return retainedOutcomes(name, nonce, async (value) => ({
		...compact(value),
		...(await wakeFailureProjection(value)),
	}));
}

/** The receiver's per-cycle read: the same retained outcomes, without opening failure notes. */
export async function wakeDeliveryRetained(name: string, nonce: string) {
	return retainedOutcomes(name, nonce, (value) => Promise.resolve(compact(value)));
}

async function retainedOutcomes<T>(
	name: string,
	nonce: string,
	project: (value: WakeOutcome) => Promise<T>,
) {
	ownMailbox(name);
	if (!/^[a-z0-9-]+$/i.test(nonce)) throw new Error('Invalid launch nonce.');
	const id = await optionalText(pointerPath(name, nonce));
	if (id !== undefined && !hash.safeParse(id).success)
		throw new Error('Invalid wake delivery pointer.');
	const value = id === undefined ? undefined : await loadWakeOutcome(name, nonce, id);
	const unresolved = await unresolvedWakeDeliveries(name, value);
	if (id !== undefined && !value) throw new Error('Wake delivery outcome is missing.');
	return {
		latest: value ? await project(value) : null,
		unresolved: await Promise.all(unresolved.slice(0, 20).map(project)),
		total: unresolved.length,
		more: unresolved.length > 20,
	};
}

function compact(value: WakeOutcome) {
	return {
		id: value.id,
		nonce: value.nonce,
		state: value.state,
		attempts: value.attempts,
		stage: value.stage,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		...(value.failedAt ? { failedAt: value.failedAt, lastFailureAt: value.lastFailureAt } : {}),
		...(value.recoveredAt ? { recoveredAt: value.recoveredAt } : {}),
		...(value.submittedBy ? { submittedBy: value.submittedBy } : {}),
		sources: value.targets.map((target) => ({
			source: target.source,
			through: target.through,
			items: target.ids.length,
		})),
	};
}
