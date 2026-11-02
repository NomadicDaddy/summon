import { join } from 'node:path';
import { z } from 'zod';

import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { runtimePath } from './mail-session.ts';

const schema = z
	.object({
		version: z.literal(1),
		owner: z.string(),
		entries: z
			.array(
				z
					.object({
						id: z.string().regex(/^[a-f0-9]{64}$/),
						nonce: z.string().regex(/^[a-z0-9-]+$/i),
					})
					.strict(),
			)
			.max(10000),
	})
	.strict();
type Entry = z.infer<typeof schema>['entries'][number];
const path = (name: string): string => join(runtimePath(name), 'wake-delivery-unresolved.json');

export async function unresolvedWakeIndex(name: string): Promise<Entry[]> {
	ownMailbox(name);
	const raw = await optionalText(path(name));
	if (raw === undefined) return [];
	try {
		if (Buffer.byteLength(raw) > 1_500_000) throw new Error('Oversized index');
		const value = schema.parse(JSON.parse(raw) as unknown);
		if (
			value.owner === name &&
			new Set(value.entries.map((entry) => entry.id)).size === value.entries.length
		)
			return value.entries;
	} catch {
		/* No persisted content in diagnostics. */
	}
	throw new Error('Invalid unresolved wake delivery index; inspect before retrying.');
}

/** Register before input; success for a newer package never clears another package's failure. */
export async function updateWakeIndex(
	name: string,
	entry: Entry,
	unresolved: boolean,
): Promise<void> {
	ownMailbox(name);
	await locked(`${path(name)}.lock`, async () => {
		const entries = (await unresolvedWakeIndex(name)).filter((item) => item.id !== entry.id);
		if (unresolved) entries.push(entry);
		const value = schema.parse({ version: 1, owner: name, entries });
		const raw = JSON.stringify(value);
		if (Buffer.byteLength(raw) > 1_500_000)
			throw new Error('Unresolved wake delivery index exceeds its storage bound.');
		await atomicWrite(path(name), raw);
	});
}
