import type { LocalEvent } from './local-room.ts';

export interface RoomQuestion {
	kind: 'approval' | 'question';
	choices: string[];
	allowFreeform: boolean;
}
export interface RoomAnswer {
	questionId: number;
	choice: number | null;
}

/** The validated human answer addresses the author of the original question. */
export function answerRecipient(event: LocalEvent, history: LocalEvent[]): string | undefined {
	if (event.sender.kind !== 'user' || !event.answer) return undefined;
	const request = history.find((item) => item.id === event.answer?.questionId);
	return request?.question && request.sender.kind === 'agent' ? request.sender.id : undefined;
}

function validQuestion(value: unknown): value is RoomQuestion {
	if (!value || typeof value !== 'object') return false;
	const q = value as Partial<RoomQuestion>;
	return (
		(q.kind === 'approval' || q.kind === 'question') &&
		typeof q.allowFreeform === 'boolean' &&
		Array.isArray(q.choices) &&
		q.choices.length <= 8 &&
		(q.choices.length > 0 || q.allowFreeform) &&
		q.choices.every(
			(s: unknown) =>
				typeof s === 'string' && s.trim() === s && s.length > 0 && s.length <= 120,
		) &&
		new Set(q.choices).size === q.choices.length &&
		(q.kind !== 'approval' ||
			(!q.allowFreeform && JSON.stringify(q.choices) === '["Yes","No"]'))
	);
}

export function validQuestionEvent(event: Partial<LocalEvent>, previous: LocalEvent[]): boolean {
	if (
		event.question !== undefined &&
		(!validQuestion(event.question) ||
			event.sender?.kind !== 'agent' ||
			event.answer !== undefined)
	)
		return false;
	if (event.answer === undefined) return true;
	const a = event.answer as RoomAnswer | null;
	if (
		!a ||
		typeof a !== 'object' ||
		event.sender?.kind !== 'user' ||
		!Number.isSafeInteger(a.questionId) ||
		a.questionId !== event.replyTo
	)
		return false;
	const q = previous.find((item) => item.id === a.questionId)?.question;
	if (!q) return false;
	if (a.choice === null) return q.allowFreeform && Boolean(event.text?.trim());
	return (
		Number.isSafeInteger(a.choice) &&
		a.choice >= 0 &&
		a.choice < q.choices.length &&
		event.text === q.choices[a.choice]
	);
}
