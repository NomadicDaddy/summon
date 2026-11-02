import type { LocalEvent } from './local-room.ts';
import type { Request } from './registration-input.ts';

import { scanLocalEvents } from './local-room.ts';
import {
	registrationTag,
	requestPlan,
	TAG_START,
	verifyProposal,
} from './registration-proposal.ts';
import { loadAgent } from './store.ts';

const TAG =
	/^\[registration-edit v1 target=(\S+) revision=([a-f0-9]{64}) expertise=(\S+) domain=(\S+)\]$/;

/**
 * A decision is the operator's Yes to the approval that `summon --registration request` posted
 * for this exact edit. The question must come from the acting PM, or, when the operator cites one,
 * from a registered PM. Its whole text must equal what requestPlan generates for this edit, and any
 * proposal file it points at must still hold the approved text. Authority is never inferred from
 * prose, and there is no standing delegation. The id is recorded exactly as given.
 * @param value The Team Room id of the operator's answer, as typed.
 * @param request The edit being authorized.
 * @param actor 'operator' or the acting PM's slug.
 * @param name The target's registered display name, as the request text spells it.
 * @returns The same text.
 */
export async function operatorDecision(
	value: string,
	request: Pick<Request, 'target' | 'revision' | 'edit'>,
	actor: string,
	name: string,
): Promise<string> {
	if (!/^[1-9]\d{0,15}$/.test(value))
		throw new Error(
			'--decision takes the Team Room id of the operator’s Yes to the approval posted by summon --registration request.',
		);
	const id = Number(value);
	let answer: LocalEvent | undefined;
	const questions = new Map<number, LocalEvent>();
	await scanLocalEvents((event) => {
		if (event.id === id) answer = event;
		if (event.question) questions.set(event.id, event);
	});
	const prefix = `Team Room #${value}`;
	if (!answer) throw new Error(`${prefix} does not exist.`);
	if (answer.sender.kind !== 'user') throw new Error(`${prefix} was not sent by the operator.`);
	if (!answer.answer)
		throw new Error(
			`${prefix} is not an answer to an approval request. Post one with summon --registration request.`,
		);
	const asked = questions.get(answer.answer.questionId);
	if (asked?.question?.kind !== 'approval')
		throw new Error(`${prefix} answers a question, not an approval request.`);
	const choice =
		answer.answer.choice === null ? undefined : asked.question.choices[answer.answer.choice];
	if (choice !== 'Yes')
		throw new Error(`${prefix} did not approve: the operator answered ${choice ?? 'freely'}.`);
	const approval = `Approval #${asked.id}`;
	const author = asked.sender.kind === 'agent' ? asked.sender.id : undefined;
	if (actor !== 'operator' && author !== actor)
		throw new Error(`${approval} was not posted by you with summon --registration request.`);
	if (
		actor === 'operator' &&
		(author === undefined ||
			(await loadAgent(author).catch(() => undefined))?.memberType !== 'pm')
	)
		throw new Error(`${approval} was not posted by a PM with summon --registration request.`);
	// The generator puts the tag on the last line; reading it first names the mismatch.
	const line = asked.text.split('\n').at(-1) ?? '';
	if (!line.includes(TAG_START))
		throw new Error(
			`${approval} is not a registration-edit request. Post one with summon --registration request.`,
		);
	const tag = TAG.exec(line);
	if (!tag) throw new Error(`${approval} has a malformed registration-edit tag.`);
	const expected = TAG.exec(registrationTag(request));
	const parts = ['target', 'revision', 'expertise', 'domain'];
	for (const [index, part] of parts.entries())
		if (tag[index + 1] !== expected?.[index + 1])
			throw new Error(
				`${approval} approved ${part}=${tag[index + 1] ?? ''}, but this edit has ${part}=${expected?.[index + 1] ?? ''}. Request approval for this exact edit.`,
			);
	const plan = requestPlan(author ?? '', name, request);
	if (asked.text !== plan.text)
		throw new Error(
			`${approval} does not match this exact edit: its text is not what summon --registration request generates for it. Request approval for this exact edit.`,
		);
	for (const field of plan.proposals) await verifyProposal(field, request.edit[field] ?? '');
	return value;
}
