import { claudeTurn } from './claude-turn-state.ts';
import { noticesHeldPrefix } from './mail-session.ts';

const recover =
	'If the seat is idle at its prompt, a message typed in its pane or summon --checkpoint in it collects queued work.';

/** A native turn hold carries a machine-readable cause; a draft keeps its separate input reason. */
export async function claudeNoticeHoldDetail(
	name: string,
	nonce: string,
): Promise<string | { kind: 'provider-not-idle'; reason: string } | undefined> {
	const held = `${noticesHeldPrefix}${name} launch ${nonce}:`;
	const providerHold = (reason: string) => ({ kind: 'provider-not-idle' as const, reason });
	const state = await claudeTurn(name, nonce);
	if (!state)
		return providerHold(
			`${held} it has no Claude turn record, so turn completion cannot be observed. ${recover}`,
		);
	if (!state.attached)
		return providerHold(
			`${held} the Claude turn hook is not attached, so turn completion cannot be observed. ${recover}`,
		);
	if (state.compactions > 0)
		return providerHold(`${held} Claude is compacting its conversation.`);
	if (state.draft) return `${held} Claude's prompt holds a draft.`;
	if (state.phase === 'busy')
		return providerHold(
			`${held} its Claude turn is recorded as busy${state.turn ? '' : ' with no observed turn start'}, and only that turn's observed completion releases it. ${recover}`,
		);
	if (state.phase === 'unknown')
		return providerHold(
			`${held} its Claude turn ended without a verified answer; waiting for Claude's idle prompt. ${recover}`,
		);
	return undefined;
}

/** Human-readable form retained for existing diagnostics and callers. */
export async function claudeNoticeHold(name: string, nonce: string): Promise<string | undefined> {
	const hold = await claudeNoticeHoldDetail(name, nonce);
	return typeof hold === 'string' ? hold : hold?.reason;
}

/**
 * Why the owned pane's human-input tracker holds notices. The tracker can stay set after a backspace
 * has emptied the box, so this names the input and its release keys, never the prompt's contents.
 */
export function claudeInputHold(name: string, nonce: string): string {
	return `${noticesHeldPrefix}${name} launch ${nonce}: recent input in this pane is holding notices; backspace does not release this input hold. Enter, Ctrl+U, Ctrl+C or Escape twice can clear it.`;
}
