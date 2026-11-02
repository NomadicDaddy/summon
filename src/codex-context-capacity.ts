import { metadataText } from './model-info.ts';

const object = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

/** Correlate native TurnStarted capacity with the exact saved model turn, never token usage. */
export function codexContextCapacity(
	lines: readonly string[],
	context: unknown,
	sessionId: string,
): number | undefined {
	const turn = metadataText(object(object(context).payload).turn_id);
	if (!turn) return undefined;
	for (let index = lines.length - 1; index >= 0; index--) {
		try {
			const event = object(JSON.parse(lines[index] ?? '') as unknown);
			const payload = object(event.payload);
			if (
				event.type !== 'event_msg' ||
				payload.type !== 'task_started' ||
				payload.turn_id !== turn
			)
				continue;
			if (payload.thread_id !== undefined && payload.thread_id !== sessionId)
				return undefined;
			const capacity = payload.model_context_window;
			return typeof capacity === 'number' && Number.isSafeInteger(capacity) && capacity > 0
				? capacity
				: undefined;
		} catch {
			// Partial native writes are not capacity observations.
		}
	}
	return undefined;
}
