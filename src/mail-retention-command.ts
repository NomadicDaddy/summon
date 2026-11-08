import { Buffer } from 'node:buffer';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';

import { currentAgent } from './mail-identity.ts';
import { withRetentionPaths } from './mail-retention-access.ts';
import { retentionInventory } from './mail-retention-inventory.ts';
import { retentionPinned, retentionPins } from './mail-retention-pins.ts';
import { mailboxPath } from './mailbox.ts';
import { assertPublicOrOwn } from './message-body-file.ts';

const PAGE_SIZE = 10;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const cursorSchema = z
	.object({
		version: z.literal(1),
		owner: z.string(),
		inventory: hash,
		pins: hash.nullable(),
		offset: z.number().int().nonnegative().max(20000),
	})
	.strict();
const idPattern = /^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\.|$)/;

function keepRule(section: string, plain: boolean, verified: boolean, pinned: boolean): string {
	if (pinned) return 'external-pin';
	if (!plain) return 'non-plain-artifact';
	if (!verified) return 'unverified-file';
	if (section === 'inbox') return 'unresolved-inbox';
	if (section === 'holds') return 'decision-evidence';
	if (section === 'delivery') return 'delivery-markers-retained';
	return 'reference-graph-incomplete';
}

/** Read-only first slice: no candidate is eligible without the combined reviewed graph. */
async function mailRetentionPreview(args: string[]) {
	const owner = currentAgent();
	let pinsFile: string | undefined;
	let token: string | undefined;
	if (args[0] !== 'preview')
		throw new Error(
			'Usage: summon --mail-retention preview [--pins-file <path>] [--cursor <token>]',
		);
	for (let index = 1; index < args.length; index += 2) {
		const value = args[index + 1];
		if (!value) throw new Error('Retention preview options require a value.');
		if (args[index] === '--pins-file' && pinsFile === undefined) pinsFile = value;
		else if (args[index] === '--cursor' && token === undefined) token = value;
		else throw new Error('Unknown or repeated retention preview option. Apply is unavailable.');
	}
	const root = mailboxPath(owner);
	let cursor: z.infer<typeof cursorSchema> | undefined;
	if (token) {
		if (token.length > 1024 || !/^[a-zA-Z0-9_-]+$/.test(token))
			throw new Error('Invalid retention cursor.');
		cursor = cursorSchema.parse(
			JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown,
		);
	}
	if (pinsFile) await assertPublicOrOwn(await realpath(resolve(pinsFile)));
	const sections = [
		'inbox',
		'archive',
		'delivery',
		'holds',
		'sent-status',
		'delivery/pending-read',
	];
	const paths = [root, ...sections.map((section) => join(root, section))];
	if (pinsFile) paths.push(resolve(pinsFile));
	return withRetentionPaths(paths, async (present, observe, canonical) => {
		const pinsIndex = sections.length + 1;
		if (pinsFile && !present[pinsIndex])
			throw new Error('Pins file is missing; preview refused.');
		if (pinsFile) {
			const pinsPath = canonical[pinsIndex];
			if (!pinsPath) throw new Error('Cannot authorize the held pin location.');
			await assertPublicOrOwn(pinsPath);
		}
		return retentionObservation(owner, root, await observe(cursor?.offset ?? 0), cursor);
	});
}

function retentionObservation(
	owner: string,
	root: string,
	raw: unknown,
	cursor: z.infer<typeof cursorSchema> | undefined,
) {
	const inventory = retentionInventory(raw);
	const pins = retentionPins(owner, inventory.pinBody);
	let offset = 0;
	if (cursor) {
		if (
			cursor.owner !== owner ||
			cursor.inventory !== inventory.sha256 ||
			cursor.pins !== pins.sha256 ||
			cursor.offset > inventory.entries.length
		)
			throw new Error(
				'Retention inputs changed or cursor belongs elsewhere; restart preview.',
			);
		offset = cursor.offset;
	}
	const rows = [];
	for (const entry of inventory.entries.slice(offset, offset + PAGE_SIZE)) {
		const name = entry.path.slice(entry.section.length + 1);
		const id = idPattern.exec(name)?.[1] ?? null;
		const pinned = retentionPinned(id, pins.tokens);
		const sha256 = entry.sha256;
		rows.push({
			domain: 'mail',
			path: entry.path,
			id,
			bytes: entry.bytes,
			sha256,
			kind: 'unclassified',
			identitySource: 'filename-and-file-metadata-only',
			disposition: 'KEEP',
			rule: keepRule(entry.section, entry.plain, sha256 !== null, pinned),
			handling: entry.section === 'archive' ? 'archive-location-only' : 'not-established',
			parentResolution: 'not-implemented',
		});
	}
	const nextOffset = offset + rows.length;
	const next =
		nextOffset < inventory.entries.length
			? Buffer.from(
					JSON.stringify({
						version: 1,
						owner,
						inventory: inventory.sha256,
						pins: pins.sha256,
						offset: nextOffset,
					}),
				).toString('base64url')
			: null;
	return {
		version: 1,
		owner,
		root,
		capturedAt: new Date().toISOString(),
		readOnly: true,
		applyAvailable: false,
		eligibleCount: 0,
		coverage: {
			inventoryComplete: inventory.complete,
			mailReferencesComplete: false,
			runtimeReferencesComplete: false,
			externalSourcesComplete: false,
			operatorHeadersComplete: false,
		},
		inventoryScope:
			'Top-level entries in own inbox, archive, delivery, holds, sent-status and pending-read only; no recursive scan.',
		inventorySha256: inventory.sha256,
		pinsSha256: pins.sha256,
		pinSourceCount: pins.sourceCount,
		observedEntries: inventory.entries.length,
		inspectedEntries: inventory.inspectedEntries,
		errors: inventory.errors,
		errorCount: inventory.errorCount,
		rows,
		next,
		lastPage: next === null,
		instruction:
			'Own-only observation, no read/handling/cursor state changed. All rows KEEP. No deletion manifest or savings claim. Full graph, operator header resolution and writer admission are not implemented.',
	};
}

export async function mailRetentionCommand(args: string[]): Promise<void> {
	console.log(JSON.stringify(await mailRetentionPreview(args)));
}
