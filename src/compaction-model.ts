import { z } from 'zod';

import { providers } from './store.ts';

export const compactionInput = z
	.object({
		provider: z.enum(providers),
		nonce: z.string().regex(/^[a-z0-9-]{1,128}$/i),
		source: z.enum(['claude-mod', 'grok-hook', 'codex-rollout', 'kilo-stream']),
		phase: z.enum(['start', 'end', 'recorded']),
		identity: z.string().regex(/^[a-f0-9]{64}$/),
		nativeAt: z.iso.datetime({ offset: true }).nullable(),
		deduplication: z.enum(['native-id', 'metadata-fingerprint']),
	})
	.strict();

export const compactionRecord = compactionInput
	.extend({
		observedAt: z.iso.datetime(),
	})
	.strict();

export type CompactionInput = z.infer<typeof compactionInput>;
export type CompactionRecord = z.infer<typeof compactionRecord>;

export function validateCompactionSource(input: CompactionInput): void {
	const source = {
		claude: 'claude-mod',
		codex: 'codex-rollout',
		grok: 'grok-hook',
		kilo: 'kilo-stream',
	};
	if (
		source[input.provider] !== input.source ||
		(input.provider === 'codex' || input.provider === 'kilo') !== (input.phase === 'recorded')
	)
		throw new Error('Compaction source or phase does not match its provider.');
}
