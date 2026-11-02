import { join } from 'node:path';
import { z } from 'zod';

import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { runtimePath } from './mail-session.ts';

/** Fixed labels only: provider output is matched in memory and never retained or shown. */
export const queueFailureClasses = [
	'embedded-server-conflict',
	'queue-db-unavailable',
	'no-daemon-flag',
	'unclassified',
] as const;
export type QueueFailureClass = (typeof queueFailureClasses)[number];
export type QueueFailureOutcome = 'exit' | 'timeout' | 'spawn-failed';

// Literal text from Codex's own queue errors. A match labels the failure; it never proves a cause.
const literals: [string, QueueFailureClass][] = [
	[
		'cannot queue through an embedded app server while a local app-server daemon is running',
		'embedded-server-conflict',
	],
	['failed to open queue db at', 'queue-db-unavailable'],
	['--no-daemon cannot be used with codex queue', 'no-daemon-flag'],
];

export function classifyQueueFailure(output: string): QueueFailureClass {
	return literals.find(([literal]) => output.includes(literal))?.[1] ?? 'unclassified';
}

function message(outcome: QueueFailureOutcome, exitCode: number | null): string {
	if (outcome === 'timeout')
		return 'Codex queue did not finish within 15 seconds; check the provider session.';
	if (outcome === 'spawn-failed')
		return 'Codex queue could not be started; check the provider session.';
	return `Codex queue failed (exit ${exitCode}); check the provider session.`;
}

/** Input may have begun, so this stays outside NotificationNotSentError's certainty. */
export class CodexQueueError extends Error {
	readonly outcome: QueueFailureOutcome;
	readonly exitCode: number | null;
	readonly failureClass: QueueFailureClass;
	constructor(
		outcome: QueueFailureOutcome,
		exitCode: number | null,
		failureClass: QueueFailureClass,
	) {
		super(message(outcome, exitCode));
		this.name = 'CodexQueueError';
		this.outcome = outcome;
		this.exitCode = exitCode;
		this.failureClass = failureClass;
	}
}

/**
 * Reads a stream to its end, or until `stop` aborts, so the child never blocks; keeps at most
 * `limit` bytes.
 */
export async function drainBounded(
	stream: ReadableStream<Uint8Array>,
	stop: AbortSignal,
	limit = 8192,
): Promise<string> {
	const kept = new Uint8Array(limit);
	let size = 0;
	const reader = stream.getReader();
	const cancel = (): void => void reader.cancel().catch(() => undefined);
	if (stop.aborted) cancel();
	else stop.addEventListener('abort', cancel, { once: true });
	for (;;) {
		// A read error ends the drain; the exit code still decides the outcome.
		const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
		if (done || !value) break;
		if (size < limit) {
			const take = value.subarray(0, limit - size);
			kept.set(take, size);
			size += take.length;
		}
	}
	// One decode over the joined bytes, so a character split across chunks survives.
	return new TextDecoder().decode(kept.subarray(0, size));
}

const nonceSchema = z.string().regex(/^[a-z0-9-]+$/i);
const entrySchema = z
	.object({
		at: z.iso.datetime(),
		outcome: z.enum(['exit', 'timeout', 'spawn-failed']),
		exitCode: z.number().int().nullable(),
		class: z.enum(queueFailureClasses),
	})
	.strict();
const storeSchema = z
	.object({
		version: z.literal(1),
		owner: z.string().min(1).max(64),
		nonce: nonceSchema,
		entries: z.array(entrySchema).max(20),
	})
	.strict();
type QueueFailureStore = z.infer<typeof storeSchema>;
export type QueueFailureEntry = z.infer<typeof entrySchema>;

const storePath = (name: string, nonce: string): string =>
	join(runtimePath(name), `${nonceSchema.parse(nonce)}.codex-queue-failures.json`);

async function readStore(name: string, nonce: string): Promise<QueueFailureStore | undefined> {
	const raw = await optionalText(storePath(name, nonce));
	if (raw === undefined) return undefined;
	try {
		const value = storeSchema.parse(JSON.parse(raw) as unknown);
		if (value.owner === name && value.nonce === nonce) return value;
	} catch {
		/* The stored content is never echoed. */
	}
	throw new Error('Codex queue diagnostics store is invalid; it was left unchanged.');
}

/** Keeps the newest twenty labels for this launch; an invalid store is never replaced. */
export async function recordQueueFailure(
	name: string,
	nonce: string,
	error: CodexQueueError,
): Promise<void> {
	ownMailbox(name);
	const path = storePath(name, nonce);
	await locked(`${path}.lock`, async () => {
		const previous = (await readStore(name, nonce))?.entries ?? [];
		const entry: QueueFailureEntry = {
			at: new Date().toISOString(),
			outcome: error.outcome,
			exitCode: error.exitCode,
			class: error.failureClass,
		};
		const value: QueueFailureStore = {
			version: 1,
			owner: name,
			nonce,
			entries: [...previous, entry].slice(-20),
		};
		await atomicWrite(path, JSON.stringify(value));
	});
}

export type QueueFailureView =
	{ retained: number; latest: QueueFailureEntry | null } | { invalid: true };

/** Own status consumer. Correlation with wake-delivery records is by time only. */
export async function queueFailureView(name: string, nonce: string): Promise<QueueFailureView> {
	ownMailbox(name);
	try {
		const entries = (await readStore(name, nonce))?.entries ?? [];
		return { retained: entries.length, latest: entries.at(-1) ?? null };
	} catch {
		return { invalid: true };
	}
}
