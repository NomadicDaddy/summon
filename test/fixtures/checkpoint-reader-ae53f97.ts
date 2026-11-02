// Frozen ae53f97 reader; import path adjusted and unused exports/types omitted.
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { systemMailSchema } from '../../src/system-mail.ts';

const checkpointId = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const position = z.number().int().nonnegative();
const sourceKind = z.enum(['room', 'telegram', 'mail', 'hold', 'mail-error']);
const mailHeader = z
	.object({
		id: checkpointId,
		from: z.string(),
		to: z.string(),
		sent: z.string(),
		kind: z.string(),
		size: position,
		systemNotice: systemMailSchema.optional(),
		noticeStatus: z.enum(['current', 'obsolete', 'unverifiable']).optional(),
	})
	.strict();
const packageItemSchema = z
	.object({
		source: sourceKind,
		id: z.string(),
		sha256: hash,
		bytes: position,
		forMe: z.boolean(),
		presentation: z.enum(['exact', 'excerpt', 'own-body-omitted']),
		firstPage: position,
		lastPage: position,
		parts: position,
	})
	.strict();
const page = z
	.object({
		receipt: checkpointId,
		payload: z.record(z.string(), z.unknown()),
		completeMail: z.array(mailHeader),
	})
	.strict();
const packageSchema = z
	.object({
		version: z.literal(1),
		owner: z.string(),
		id: checkpointId,
		createdAt: z.string(),
		items: z.array(packageItemSchema),
		pages: z.array(page),
		finalReceipt: checkpointId,
		sources: z
			.object({
				room: z.object({ from: position, through: position }).strict(),
				telegram: z
					.object({ from: position, through: position, key: hash })
					.strict()
					.optional(),
				holds: z.record(checkpointId, hash),
			})
			.strict(),
	})
	.strict();
export const checkpointStateSchema = z
	.object({
		version: z.literal(2),
		lastAck: checkpointId.optional(),
		emptyReceipt: checkpointId.optional(),
		completedPackage: checkpointId.optional(),
		current: z.object({ id: checkpointId, sha256: hash, page: position }).strict().optional(),
		seenHolds: z.record(checkpointId, hash),
	})
	.strict();
export type CheckpointPackage = z.infer<typeof packageSchema>;
export type CheckpointState = z.infer<typeof checkpointStateSchema>;

/** Hashes canonical JSON presentation, never a credential or an unshown original excerpt. */
export function checkpointHash(value: unknown): string {
	const canonical = (item: unknown): unknown => {
		if (Array.isArray(item)) return item.map(canonical);
		if (item !== null && typeof item === 'object')
			return Object.fromEntries(
				Object.entries(item)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([key, entry]) => [key, canonical(entry)]),
			);
		return item;
	};
	return createHash('sha256')
		.update(JSON.stringify(canonical(value)))
		.digest('hex');
}

export function parseCheckpointState(raw: string | undefined): CheckpointState {
	if (raw === undefined) return { version: 2, seenHolds: {} };
	try {
		const parsed = checkpointStateSchema.safeParse(JSON.parse(raw) as unknown);
		if (parsed.success) return parsed.data;
	} catch {
		/* Never include corrupt persisted content in a diagnostic. */
	}
	throw new Error(
		'Checkpoint state needs the reviewed offline migration. Nothing was acknowledged.',
	);
}

export function parseCheckpointPackage(raw: string): CheckpointPackage {
	try {
		const parsed = packageSchema.safeParse(JSON.parse(raw) as unknown);
		if (parsed.success) return parsed.data;
	} catch {
		/* Keep bodies and paths out of parse failures. */
	}
	throw new Error('Invalid frozen checkpoint package. Nothing was acknowledged.');
}
