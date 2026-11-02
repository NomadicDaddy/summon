import type { RoomQuestion } from './room-question.ts';

import { communicationSend } from './communication-gate.ts';
import { localAgent } from './local-room-access.ts';
import { appendLocalEvent, localEvents } from './local-room.ts';
import { operatorOnly } from './mail-identity.ts';

export async function askRoom(args: string[]) {
	const name = await localAgent();
	const approval = args[0] === '--approval';
	const text = args[approval ? 1 : 0];
	const options = args.slice(approval ? 2 : 1);
	const question: RoomQuestion = {
		kind: approval ? 'approval' : 'question',
		choices: approval ? ['Yes', 'No'] : [],
		allowFreeform: !approval,
	};
	if (!text || (approval && options.length))
		throw new Error(
			'Usage: ask --approval <text> | ask <text> [--choice <label>] [--no-freeform]',
		);
	for (let i = 0; i < options.length; i++) {
		if (options[i] === '--no-freeform') question.allowFreeform = false;
		else if (options[i] === '--choice' && options[i + 1] !== undefined) {
			question.choices.push(options[i + 1] ?? '');
			i++;
		} else throw new Error('Unknown question option. Use --choice <label> or --no-freeform.');
	}
	return communicationSend('post the Room question', () =>
		appendLocalEvent({
			sender: { kind: 'agent', id: name },
			text,
			replyTo: null,
			source: 'local',
			question,
		}),
	);
}

export async function answerRoom(questionId: number, choice: number | null, text = '') {
	operatorOnly();
	if (
		!Number.isSafeInteger(questionId) ||
		(choice !== null && !Number.isSafeInteger(choice)) ||
		typeof text !== 'string'
	)
		throw new Error('Invalid question answer.');
	const request = (await localEvents()).find((item) => item.id === questionId);
	const question = request?.question;
	if (!question) throw new Error('Question not found.');
	const answerText = choice === null ? text.trim() : question.choices[choice];
	if (answerText === undefined) throw new Error('Invalid question choice.');
	const event = await appendLocalEvent({
		sender: { kind: 'user', id: 'operator' },
		text: answerText,
		replyTo: questionId,
		source: 'local',
		answer: { questionId, choice },
	});
	if (question.kind === 'approval' && choice !== null) {
		const { answerHeadDown } = await import('./head-down.ts');
		await answerHeadDown(request.sender.id, questionId, choice === 0);
	}
	return event;
}
