import { claudeTurn } from './claude-turn-state.ts';
import { noticesHeldPrefix } from './mail-session.ts';

const recover =
	'If the seat is idle at its prompt, a message typed in its pane or summon --checkpoint in it collects queued work.';

/**
 * Why the Claude turn gate holds ordinary notices, so a held wake shows in own mail status instead
 * of returning silently. Undefined means the gate is open; this never changes whether it holds.
 */
export async function claudeNoticeHold(name: string, nonce: string): Promise<string | undefined> {
	const held = `${noticesHeldPrefix}${name} launch ${nonce}:`;
	const state = await claudeTurn(name, nonce);
	if (!state)
		return `${held} it has no Claude turn record, so turn completion cannot be observed. ${recover}`;
	if (!state.attached)
		return `${held} the Claude turn hook is not attached, so turn completion cannot be observed. ${recover}`;
	if (state.compactions > 0) return `${held} Claude is compacting its conversation.`;
	if (state.draft) return `${held} Claude's prompt holds a draft.`;
	if (state.phase === 'busy')
		return `${held} its Claude turn is recorded as busy${state.turn ? '' : ' with no observed turn start'}, and only that turn's observed completion releases it. ${recover}`;
	if (state.phase === 'unknown')
		return `${held} its Claude turn ended without a verified answer; waiting for Claude's idle prompt. ${recover}`;
	return undefined;
}

/**
 * Why the owned pane's human-input tracker holds notices. The tracker can stay set after a backspace
 * has emptied the box, so this names the input and its release keys, never the prompt's contents.
 */
export function claudeInputHold(name: string, nonce: string): string {
	return `${noticesHeldPrefix}${name} launch ${nonce}: recent input in this pane is holding notices; backspace does not release this input hold. Enter, Ctrl+U, Ctrl+C or Escape twice can clear it.`;
}
