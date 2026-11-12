import { z } from 'zod';

import { checkpointId, checkpointStateSchema } from './checkpoint-package-model.ts';

const position = z.number().int().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const range = z.object({ from: position, through: position, count: position }).strict();
const reference = z
	.object({
		source: z.enum(['room', 'telegram']),
		id: z.string().regex(/^\d+$/),
		addressed: z.boolean(),
		body: z.string(),
		snippet: z.string().max(240),
		parents: z
			.array(
				z
					.object({ source: z.enum(['room', 'telegram']), id: z.string().regex(/^\d+$/) })
					.strict(),
			)
			.max(2),
	})
	.strict();

const skipPlanSchema = z
	.object({
		version: z.literal(1),
		owner: z.string(),
		id: checkpointId,
		createdAt: z.string(),
		keepPages: z.number().int().min(1).max(3),
		state: checkpointStateSchema,
		room: range,
		roomHash: hash,
		telegram: range.extend({ key: hash }).optional(),
		telegramHash: hash.optional(),
		/** Set when the Telegram refresh was incomplete: its cursor is held and nothing from it is skipped. */
		telegramHeld: z.enum(['refresh-busy', 'request-failed']).optional(),
		references: z.array(reference),
	})
	.strict();
export type SkipPlan = z.infer<typeof skipPlanSchema>;
export const skipPlanEnvelopeSchema = z
	.object({ version: z.literal(1), sha256: hash, plan: skipPlanSchema })
	.strict();

export const skipAppliedSchema = z
	.object({
		id: checkpointId,
		owner: z.string(),
		sha256: hash,
		appliedAt: z.string(),
		disposition: z.literal('skipped'),
	})
	.strict();

/** Keep complete events in a roughly page-sized tail; never split a message at a cursor. */
export function skippedThrough<T>(
	events: readonly T[],
	from: number,
	keepPages: number,
	positionOf: (event: T) => number,
): { from: number; through: number; count: number } {
	const unread = events.filter((event) => positionOf(event) > from);
	let bytes = 0;
	let keep = unread.length;
	for (let index = unread.length - 1; index >= 0; index--) {
		const event = unread[index];
		if (!event) break;
		const size = Buffer.byteLength(JSON.stringify(event));
		if (bytes && bytes + size > keepPages * 26_000) break;
		bytes += size;
		keep = index;
	}
	const lastSkipped = unread[keep - 1];
	return {
		from,
		through: lastSkipped === undefined ? from : positionOf(lastSkipped),
		count: keep,
	};
}

export function validateSkipPlan(value: unknown, owner: string): SkipPlan {
	const plan = skipPlanSchema.parse(value);
	const keys = new Set(plan.references.map((item) => `${item.source}:${item.id}`));
	if (
		plan.owner !== owner ||
		plan.room.through < plan.room.from ||
		plan.room.count !== plan.room.through - plan.room.from ||
		(plan.telegram && plan.telegram.through < plan.telegram.from) ||
		Boolean(plan.telegram) !== Boolean(plan.telegramHash) ||
		(plan.telegramHeld !== undefined &&
			(!plan.telegram ||
				plan.telegram.count !== 0 ||
				plan.telegram.through !== plan.telegram.from)) ||
		keys.size !== plan.references.length ||
		plan.references.some((item) =>
			item.parents.some((parent) => !keys.has(`${parent.source}:${parent.id}`)),
		)
	)
		throw new Error('Invalid own-session catch-up plan. Nothing was skipped.');
	return plan;
}
