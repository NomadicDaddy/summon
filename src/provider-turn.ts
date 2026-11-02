import type { Provider } from './store.ts';

import { claudeTurn } from './claude-turn-state.ts';
import { codexTurn } from './codex-turn.ts';
import { grokTurn } from './grok-turn-state.ts';
import { kiloTurn } from './kilo-turn-state.ts';

/**
 * Current-launch provider evidence, distinct from the teammate's self-reported activity.
 * Codex reads its bound thread's live daemon status, failing closed when unavailable.
 * Other providers' missing records retain their existing policy unless the caller asks for
 * missing evidence to count as unknown; old launches never count.
 */
export async function providerTurn(
	provider: Provider,
	slug: string,
	nonce: string,
	options: { missingIsUnknown?: boolean } = {},
): Promise<'busy' | 'unknown' | undefined> {
	if (provider === 'codex') {
		const phase = await codexTurn(slug, nonce).catch(() => 'unknown' as const);
		return phase === 'idle' ? undefined : phase;
	}
	let state;
	try {
		state =
			provider === 'claude'
				? await claudeTurn(slug, nonce)
				: provider === 'kilo'
					? await kiloTurn(slug, nonce)
					: await grokTurn(slug, nonce);
	} catch {
		// Malformed, mismatched or unreadable evidence must not be treated as observed idle.
		return 'unknown';
	}
	if (state === undefined && options.missingIsUnknown) return 'unknown';
	return state?.phase === 'busy' || state?.phase === 'unknown' ? state.phase : undefined;
}
