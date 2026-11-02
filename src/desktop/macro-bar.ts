import type { TeamMacro } from '../team-macros.ts';

import { faultText, reportFault } from './fault-report.ts';
import { readableError } from './ipc-error.ts';

const listeners = new Set<(value: TeamMacro[]) => void>();
let loaded: Promise<TeamMacro[]> | undefined;

export function publishMacros(value: TeamMacro[]): void {
	loaded = Promise.resolve(value);
	for (const listener of listeners) listener(value);
}

export function setupMacroBar(
	host: HTMLElement,
	insert: (text: string, send: boolean) => void,
	enabled: () => boolean = () => true,
): void {
	const render = (macros: TeamMacro[]): void => {
		host.replaceChildren();
		for (const macro of macros.filter((value) => value.text.trim())) {
			const button = document.createElement('button');
			button.type = 'button';
			const label = macro.text.replace(/\s+/g, ' ').trim();
			button.textContent = label.length > 60 ? `${label.slice(0, 59)}…` : label;
			button.title = `${macro.text}\n${macro.send ? 'Insert and Send Enter' : 'Insert Without Sending'}`;
			button.disabled = !enabled();
			button.addEventListener('click', () => insert(macro.text, macro.send));
			host.append(button);
		}
	};
	listeners.add(render);
	loaded ??= window.team.macros();
	void loaded.then(render).catch((error: unknown) => {
		host.textContent = `Macros unavailable: ${readableError(error)}`;
		reportFault({ level: 'error', source: 'macros.load', text: faultText(error) });
	});
}
