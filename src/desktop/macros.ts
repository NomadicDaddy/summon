import type { TeamMacro } from '../team-macros.ts';

import { dismissOnOutsideClick } from './dialog-dismiss.ts';
import { faultText, reportFault } from './fault-report.ts';
import { readableError } from './ipc-error.ts';
import { publishMacros } from './macro-bar.ts';

export function setupMacros(): void {
	const toggle = document.getElementById('macros-toggle');
	if (!toggle) throw new Error('Missing Macros button.');
	const dialog = document.createElement('dialog');
	dialog.id = 'macros';
	dialog.setAttribute('aria-labelledby', 'macros-title');
	dialog.innerHTML = `<form><div class="room-header"><h2 id="macros-title">Macros</h2>
<button type="button" id="macros-close">Close</button></div>
<p>Ten shared shortcuts. The text is the button label and the message. Clear it to hide a slot.</p>
<div id="macro-slots"></div><p id="macros-error" role="alert"></p>
<button id="macros-save" class="primary" type="submit">Save Macros</button></form>`;
	document.body.append(dialog);
	const form = dialog.querySelector('form');
	const slots = dialog.querySelector('#macro-slots');
	const error = dialog.querySelector('#macros-error');
	const close = dialog.querySelector('#macros-close');
	if (!form || !slots || !error || !close) throw new Error('Missing macro editor controls.');
	const rows: { text: HTMLTextAreaElement; send: HTMLInputElement }[] = [];
	let original = '';
	let opening = false;
	let saving = false;
	const values = (): TeamMacro[] =>
		rows.map(({ text, send }) => ({
			text: text.value,
			send: send.checked,
		}));
	const canClose = (): boolean =>
		!saving &&
		(JSON.stringify(values()) === original || window.confirm('Discard unsaved macro changes?'));
	// One guard for every way out: a stray backdrop click used to close without it and drop the edits.
	dismissOnOutsideClick(dialog, canClose);
	close.addEventListener('click', () => {
		if (canClose()) dialog.close();
	});
	dialog.addEventListener('cancel', (event) => {
		if (!canClose()) event.preventDefault();
	});
	dialog.addEventListener('close', () => toggle.focus());
	toggle.addEventListener('click', () => {
		// Keep a single opening response: another one could replace edits after the dialog opens.
		if (opening || dialog.open || saving) return;
		opening = true;
		void window.team
			.macros()
			.then((macros) => {
				rows.length = 0;
				slots.replaceChildren();
				macros.forEach((macro, index) => {
					const row = document.createElement('fieldset');
					const legend = document.createElement('legend');
					legend.textContent = `Slot ${index + 1}`;
					row.append(legend);
					const text = document.createElement('textarea');
					text.maxLength = 4096;
					text.rows = 1;
					text.placeholder = 'Empty, hidden from the bar';
					text.setAttribute('aria-label', `Slot ${index + 1} text`);
					text.value = macro.text;
					const send = document.createElement('input');
					send.type = 'checkbox';
					send.checked = macro.send;
					for (const [caption, control] of [
						['', text],
						['Send Enter', send],
					] as const) {
						const wrapper = document.createElement('label');
						wrapper.append(caption, control);
						row.append(wrapper);
					}
					slots.append(row);
					rows.push({ text, send });
				});
				original = JSON.stringify(values());
				error.textContent = '';
				dialog.showModal();
			})
			.catch((cause: unknown) => {
				reportFault({ level: 'error', source: 'macros.open', text: faultText(cause) });
				window.alert(readableError(cause));
			})
			.finally(() => {
				opening = false;
			});
	});
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		if (saving) return;
		saving = true;
		const requested = values();
		for (const field of dialog.querySelectorAll('fieldset')) field.disabled = true;
		void window.team
			.saveMacros(requested)
			.then((macros) => {
				publishMacros(macros);
				original = JSON.stringify(macros);
				dialog.close();
			})
			.catch((cause: unknown) => {
				error.textContent = readableError(cause);
				reportFault({ level: 'error', source: 'macros.save', text: faultText(cause) });
			})
			.finally(() => {
				saving = false;
				for (const field of dialog.querySelectorAll('fieldset')) field.disabled = false;
			});
	});
}
