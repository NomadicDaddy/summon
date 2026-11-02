import type { CheckpointInput } from './checkpoint-package-pages.ts';
import type { LocalEvent } from './local-room.ts';
import type { RoomEvent } from './telegram-room.ts';

import { addressableText } from './room-address.ts';
import { answerRecipient } from './room-question.ts';
import { addressedTo } from './room-wake.ts';

function addressed(
	name: string,
	event: Pick<LocalEvent, 'sender' | 'text' | 'replyTo' | 'groups'>,
	parent?: Pick<LocalEvent, 'sender'>,
): boolean {
	if (event.sender.kind === 'agent' && event.sender.id === name) return false;
	if (addressedTo(event, name)) return true;
	if (parent?.sender.kind === 'agent' && parent.sender.id === name) return true;
	return (
		event.sender.kind !== 'agent' &&
		event.replyTo === null &&
		!/(?<![\p{L}\p{N}_@])@[\p{L}\p{N}_-]+/u.test(addressableText(event.text))
	);
}

/** Exact request first, then its ancestor bodies; unrelated history stays in checkpoint. */
export function currentRoomInputs(
	name: string,
	history: LocalEvent[],
	from: number,
): CheckpointInput[] {
	const selected = history.filter(
		(event) =>
			event.id > from &&
			(answerRecipient(event, history) === name ||
				addressed(
					name,
					event,
					event.replyTo === null ? undefined : history[event.replyTo - 1],
				)),
	);
	const seen = new Set<number>();
	const inputs: CheckpointInput[] = [];
	for (const request of selected.toReversed()) {
		let event: LocalEvent | undefined = request;
		while (!seen.has(event.id)) {
			seen.add(event.id);
			inputs.push({
				source: 'room',
				id: String(event.id),
				forMe: event.id === request.id,
				presentation: 'exact',
				value: event,
			});
			if (event.replyTo === null) break;
			event = history[event.replyTo - 1];
			if (!event) throw new Error('Current request reply context is unavailable.');
		}
	}
	return inputs;
}

export function currentTelegramInputs(
	name: string,
	history: RoomEvent[],
	from: number,
	local: LocalEvent[] = [],
): CheckpointInput[] {
	const byId = new Map(history.map((event) => [event.messageId, event]));
	const selected = history.filter(
		(event) =>
			event.sequence > from &&
			addressed(
				name,
				event,
				event.localReplyTo
					? local[event.localReplyTo - 1]
					: event.replyTo === null
						? undefined
						: byId.get(event.replyTo),
			),
	);
	const seen = new Set<number>();
	const inputs: CheckpointInput[] = [];
	for (const request of selected.toReversed()) {
		let event: RoomEvent | undefined = request;
		while (!seen.has(event.messageId)) {
			seen.add(event.messageId);
			inputs.push({
				source: 'telegram',
				id: String(event.sequence),
				forMe: event.messageId === request.messageId,
				presentation: 'exact',
				value: event,
			});
			if (event.localReplyTo) {
				let context = local[event.localReplyTo - 1];
				if (!context)
					throw new Error('Current Telegram local reply context is unavailable.');
				for (;;) {
					inputs.push({
						source: 'room',
						id: String(context.id),
						forMe: false,
						presentation: 'exact',
						value: context,
					});
					if (context.replyTo === null) break;
					context = local[context.replyTo - 1];
					if (!context)
						throw new Error('Current Telegram local reply context is unavailable.');
				}
			}
			if (event.replyTo === null) break;
			event = byId.get(event.replyTo);
			if (!event) throw new Error('Current Telegram request reply context is unavailable.');
		}
	}
	return inputs;
}

/** Each source contributes its newest request before another source's older requests. */
export function interleaveCurrentInputs(sources: CheckpointInput[][]): CheckpointInput[] {
	const groups = sources.map((inputs) => {
		const batches: CheckpointInput[][] = [];
		for (const input of inputs) {
			if (input.forMe || batches.length === 0) batches.push([]);
			batches.at(-1)?.push(input);
		}
		return batches;
	});
	const result: CheckpointInput[] = [];
	for (let index = 0; groups.some((source) => source[index]); index++)
		for (const source of groups) result.push(...(source[index] ?? []));
	return result;
}
