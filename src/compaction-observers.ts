import { z } from 'zod';

import { claudeTurn, claudeTurnEventSchema } from './claude-turn-state.ts';
import { compactionIdentity, retainCompaction } from './compaction-history.ts';
import { grokTurn } from './grok-turn-state.ts';
import { kiloTurn } from './kilo-turn-state.ts';

/** Called after the authenticated ordered observer accepts the exact current launch event. */
export async function retainClaudeCompaction(
	name: string,
	nonce: string,
	observer: string,
	input: unknown,
): Promise<void> {
	const event = claudeTurnEventSchema.parse(input);
	if (event.kind !== 'compact-start' && event.kind !== 'compact-end') return;
	const state = await claudeTurn(name, nonce);
	if (
		!state ||
		state.observer !== observer ||
		state.thread !== event.session ||
		state.epoch !== event.epoch ||
		state.sequence !== event.sequence ||
		!state.attached
	)
		return;
	await retainCompaction(name, {
		provider: 'claude',
		nonce,
		source: 'claude-mod',
		phase: event.kind === 'compact-start' ? 'start' : 'end',
		identity: compactionIdentity([observer, event.epoch, event.sequence]),
		nativeAt: null,
		deduplication: 'native-id',
	});
}

const grokMetadata = z.object({
	hook_event_name: z.enum(['PreCompact', 'PostCompact']),
	sessionId: z.string().min(1).max(128),
	timestamp: z.iso.datetime({ offset: true }),
	subagentType: z.string().optional(),
});

/** Select public common fields only; no trigger key or child identity is invented. */
export async function retainGrokCompaction(
	name: string,
	nonce: string,
	input: unknown,
): Promise<void> {
	const parsed = grokMetadata.safeParse(input);
	if (!parsed.success) return;
	const event = parsed.data;
	if (event.subagentType) return;
	const state = await grokTurn(name, nonce);
	if (
		!state ||
		state.thread !== event.sessionId ||
		event.sessionId !== process.env.GROK_SESSION_ID
	)
		return;
	await retainCompaction(name, {
		provider: 'grok',
		nonce,
		source: 'grok-hook',
		phase: event.hook_event_name === 'PreCompact' ? 'start' : 'end',
		identity: compactionIdentity([event.sessionId, event.hook_event_name, event.timestamp]),
		nativeAt: event.timestamp,
		deduplication: 'metadata-fingerprint',
	});
}

const kiloMetadata = z.object({
	type: z.literal('session.compacted'),
	id: z.string().min(1).max(128),
	properties: z.object({ sessionID: z.string().min(1).max(128) }),
});

/** Published SDK event; only the authenticated owned stream's exact session is retained. */
export async function retainKiloCompaction(
	name: string,
	nonce: string,
	observer: string,
	input: unknown,
): Promise<void> {
	const parsed = kiloMetadata.safeParse(input);
	if (!parsed.success) return;
	const event = parsed.data;
	const state = await kiloTurn(name, nonce);
	if (!state || state.observer !== observer || state.thread !== event.properties.sessionID)
		return;
	await retainCompaction(name, {
		provider: 'kilo',
		nonce,
		source: 'kilo-stream',
		phase: 'recorded',
		identity: compactionIdentity([state.thread, event.id]),
		nativeAt: null,
		deduplication: 'native-id',
	});
}
