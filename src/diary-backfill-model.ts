import { createHash } from 'node:crypto';
import { z } from 'zod';

import { diaryEntry, diaryHappenedAt } from './diary-model.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const update = z
	.object({ task: diaryEntry.shape.task.optional(), happenedAt: diaryHappenedAt.optional() })
	.strict()
	.refine((value) => value.task !== undefined || value.happenedAt !== undefined, 'Empty update.');
const operation = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('add'),
			entry: diaryEntry.omit({ at: true }).extend({ happenedAt: diaryHappenedAt }),
		})
		.strict(),
	z
		.object({
			kind: z.literal('update'),
			id: z.uuid(),
			expectedSha256: digest,
			changes: update,
		})
		.strict(),
	z.object({ kind: z.literal('remove'), id: z.uuid(), expectedSha256: digest }).strict(),
]);

export const diaryBackfillPlan = z
	.object({
		version: z.literal(1),
		id: z.uuid(),
		teamRoot: z.string().min(1).max(4096),
		approvalRoom: z.array(z.number().int().positive()).min(1).max(8),
		operations: z.array(operation).min(1).max(1000),
	})
	.strict()
	.refine((value) => {
		const ids = value.operations.map((item) => (item.kind === 'add' ? item.entry.id : item.id));
		return new Set(ids).size === ids.length;
	}, 'A plan cannot change the same entry twice.');

export type DiaryBackfillPlan = z.infer<typeof diaryBackfillPlan>;

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return (value as unknown[]).map(canonical);
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonical(child)]),
		);
	return value;
}

/** Compare actual entry values, including whitespace, independently of object key order. */
export function diaryEntryHash(value: unknown): string {
	diaryEntry.parse(value);
	return createHash('sha256')
		.update(JSON.stringify(canonical(value)))
		.digest('hex');
}
