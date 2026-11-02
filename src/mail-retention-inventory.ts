import { createHash } from 'node:crypto';
import { z } from 'zod';

const inventorySchema = z.object({
	entries: z
		.array(
			z.object({
				path: z.string().max(300),
				section: z.enum(['inbox', 'archive', 'delivery', 'holds']),
				bytes: z.number().int().nonnegative(),
				mtimeMs: z.number(),
				identity: z.string().max(200),
				plain: z.boolean(),
				sha256: z
					.string()
					.regex(/^[a-f0-9]{64}$/)
					.nullable(),
			}),
		)
		.max(20000),
	complete: z.boolean(),
	errors: z.array(z.string().max(300)).max(20),
	errorCount: z.number().int().nonnegative(),
	inspectedEntries: z.number().int().nonnegative().max(20000),
	pinBody: z.string().max(1_333_336).nullable(),
});

/** Decode only the guarded worker's observations. No pathname is read here. */
export function retentionInventory(raw: unknown) {
	const inventory = inventorySchema.parse(raw);
	const metadata = inventory.entries.map(
		({ path, section, bytes, mtimeMs, identity, plain }) => ({
			path,
			section,
			bytes,
			mtimeMs,
			identity,
			plain,
		}),
	);
	return {
		...inventory,
		sha256: createHash('sha256').update(JSON.stringify(metadata)).digest('hex'),
	};
}
