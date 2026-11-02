import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { Hold } from './mail-attention.ts';

import {
	checkpointHash,
	checkpointId,
	type CheckpointState,
	checkpointStateSchema,
} from './checkpoint-package-model.ts';

const position = z.number().int().nonnegative();
const oldState = z
	.object({
		seen: z.array(z.string()),
		lastAck: checkpointId.optional(),
		mailNext: z.string().nullable(),
		holdNext: z.string().nullable(),
		pending: z
			.object({
				token: checkpointId,
				room: position,
				telegram: position.optional(),
				seen: z.array(z.string()),
				mailNext: z.string().nullable(),
				holdNext: z.string().nullable(),
				output: z.record(z.string(), z.unknown()),
				readMail: z.array(z.unknown()),
			})
			.strict()
			.optional(),
	})
	.strict();

/** Deferred owners retain a valid old state; neither its batch nor its receipt is consumed. */
export function assertDeferredCheckpointState(raw: string): void {
	try {
		if (oldState.safeParse(JSON.parse(raw) as unknown).success) return;
	} catch {
		/* Do not include private persisted content in the refusal. */
	}
	throw new Error('Deferred owner requires a valid legacy checkpoint state; migration refused.');
}

/** Pure conversion. No source cursor, read marker, hold decision or message is changed. */
export function migrateCheckpointState(
	raw: string,
	room: number,
	telegram: number | undefined,
	holds: Hold[],
): CheckpointState {
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
	} catch {
		throw new Error('Malformed checkpoint state; migration refused.');
	}
	const current = checkpointStateSchema.safeParse(value);
	if (current.success) return current.data;
	const parsed = oldState.safeParse(value);
	if (!parsed.success) throw new Error('Unknown checkpoint schema; migration refused.');
	const old = parsed.data;
	const pending = old.pending;
	// The terminal empty receipt carries the completed scan's null continuation pointers.
	// Saved pointers belong to the preceding acknowledged page until this receipt is passed.
	if (
		(!pending && (old.mailNext !== null || old.holdNext !== null)) ||
		(pending &&
			(pending.output.changed !== false ||
				pending.output.more !== false ||
				pending.output.receipt !== pending.token ||
				Object.keys(pending.output).some(
					(key) => !['paused', 'receipt', 'changed', 'more'].includes(key),
				) ||
				pending.readMail.length !== 0 ||
				pending.mailNext !== null ||
				pending.holdNext !== null ||
				pending.room !== room ||
				(pending.telegram !== undefined && pending.telegram !== telegram)))
	)
		throw new Error(
			'Unsettled checkpoint batch; read and acknowledge it with the current release before shutdown. Migration refused.',
		);
	const seenHolds: Record<string, string> = {};
	for (const hold of holds) {
		const previous = createHash('sha256').update(JSON.stringify(hold)).digest('hex');
		if (old.seen.includes(previous)) seenHolds[hold.id] = checkpointHash(hold);
	}
	return {
		version: 2,
		seenHolds,
		...(old.lastAck ? { lastAck: old.lastAck } : {}),
		...(pending ? { emptyReceipt: pending.token } : {}),
	};
}
