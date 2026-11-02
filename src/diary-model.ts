import { z } from 'zod';

export const DIARY_MAX_BYTES = 8 * 1024 * 1024;

/** Keep a known day as a day; an instant must carry its timezone explicitly. */
export const diaryHappenedAt = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export const diaryFields = z
	.object({
		for: z.string().trim().min(1).max(80),
		task: z.string().trim().min(1).max(300),
		room: z.array(z.number().int().positive()).max(8).default([]),
		board: z.array(z.uuid()).max(8).default([]),
		happenedAt: diaryHappenedAt.optional(),
	})
	.strict();

export const diaryEntry = diaryFields.extend({
	id: z.uuid(),
	at: z.iso.datetime(),
	author: z.object({ kind: z.enum(['agent', 'operator']), id: z.string().min(1) }).strict(),
});

export const diaryDocument = z
	.object({ version: z.literal(1), entries: z.array(diaryEntry) })
	.strict();
