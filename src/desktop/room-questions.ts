import type { LocalEvent } from '../local-room.ts';

import { faultText, reportFault } from './fault-report.ts';
import { readableError } from './ipc-error.ts';

export function renderRoomQuestion(item: HTMLElement, event: LocalEvent): void {
	if (event.answer) {
		const card = document.getElementById(`room-message-${event.answer.questionId}`);
		if (card) markAnswered(card, event);
	}
	if (!event.question) return;
	// Both are gold because both are ACTIONABLE, but they are not the same weight and the colour now
	// says so: an approval gates an action somebody is waiting to take, a question asks which of
	// several ways to go. Until #4212 the only difference was this heading, which the reader had to
	// stop and read to tell a decision from a choice.
	item.classList.add('room-question', `room-question-${event.question.kind}`);
	const title = document.createElement('h3');
	title.textContent = event.question.kind === 'approval' ? 'Approval requested' : 'Question';
	item.prepend(title);
	const controls = document.createElement('fieldset');
	controls.className = 'room-question-controls';
	const legend = document.createElement('legend');
	legend.textContent = 'Your answer';
	controls.append(legend);
	const status = document.createElement('div');
	status.className = 'room-question-status';
	status.setAttribute('role', 'status');
	const submit = async (choice: number | null, text?: string): Promise<void> => {
		if (controls.disabled) return;
		controls.disabled = true;
		status.textContent = 'Sending answer…';
		try {
			markAnswered(item, await window.team.roomAnswer(event.id, choice, text));
		} catch (cause: unknown) {
			status.textContent = readableError(cause);
			reportFault({ level: 'error', source: 'room.answer', text: faultText(cause) });
			controls.disabled = false;
		}
	};
	for (const [index, label] of event.question.choices.entries()) {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = label;
		button.addEventListener('click', () => {
			void submit(index);
		});
		controls.append(button);
	}
	if (event.question.allowFreeform) {
		const form = document.createElement('form');
		const input = document.createElement('input');
		input.type = 'text';
		input.maxLength = 4096;
		input.required = true;
		input.placeholder = 'Your own answer';
		input.setAttribute('aria-label', `Your answer to question #${event.id}`);
		const button = document.createElement('button');
		button.type = 'submit';
		button.textContent = 'Answer';
		form.append(input, button);
		form.addEventListener('submit', (e) => {
			e.preventDefault();
			if (input.value.trim()) void submit(null, input.value);
		});
		controls.append(form);
	}
	const anchor = item.querySelector('p')?.nextSibling ?? null;
	item.insertBefore(controls, anchor);
	item.insertBefore(status, anchor);
}

function markAnswered(card: HTMLElement, answer: LocalEvent): void {
	const controls = card.querySelector<HTMLFieldSetElement>('.room-question-controls');
	if (controls) controls.disabled = true;
	const status = card.querySelector('.room-question-status');
	if (status) status.textContent = `You answered: ${answer.text} · #${answer.id}`;
	card.classList.add('answered');
}
