import type { TeamAgent } from './types.ts';

import { responseFact, responseFacts, type ResponseView } from './response-watchdog-facts.ts';

const COPY_LABEL = 'Copy delivery details';

/**
 * The copy control. It writes through the window's clipboard bridge (operator:copy, Electron's
 * clipboard in the main process) like every other copy in the Team Window: the renderer's
 * navigator.clipboard refused with "Write permission denied" (#12027, #12033). Success is said on
 * the button itself for a moment, as room copy does, because feedback anywhere else reads as none
 * (#4529). A refusal says Not copied there too (#12030), and its reason goes to the error banner.
 */
function copyControl(read: () => ResponseView, showError: (error: unknown) => void) {
	const copy = document.createElement('button');
	copy.type = 'button';
	copy.textContent = COPY_LABEL;
	let reset: ReturnType<typeof setTimeout> | undefined;
	const say = (outcome: string) => {
		copy.textContent = outcome;
		reset = setTimeout(() => {
			copy.textContent = COPY_LABEL;
		}, 1500);
	};
	// In flight by flag and aria-disabled, never `disabled`, so keyboard focus stays on the button.
	let copying = false;
	copy.addEventListener('click', () => {
		if (copying) return;
		copying = true;
		// A new attempt clears the last one's outcome, so a refusal can never inherit Copied.
		clearTimeout(reset);
		copy.textContent = COPY_LABEL;
		copy.setAttribute('aria-disabled', 'true');
		void window.team
			.operatorCopy(JSON.stringify(read(), null, 2))
			.then(() => {
				say('Copied');
			})
			.catch((error: unknown) => {
				say('Not copied');
				showError(error);
			})
			.finally(() => {
				copying = false;
				copy.removeAttribute('aria-disabled');
			});
	});
	return copy;
}

function responseItem(agent: TeamAgent, state: ResponseView, showError: (error: unknown) => void) {
	const details = document.createElement('details');
	const summary = document.createElement('summary');
	const facts = document.createElement('p');
	const note = document.createElement('p');
	note.textContent =
		'Missing read confirmation does not prove a crashed session or lost input. Nothing is retried automatically.';
	let current = state;
	const copy = copyControl(() => current, showError);
	const dismiss = document.createElement('button');
	dismiss.type = 'button';
	dismiss.textContent = 'Dismiss';
	dismiss.title = 'Hides this alert. Nothing is marked read and nothing is sent.';
	dismiss.addEventListener('click', () => {
		void window.team.dismissResponse(agent.slug, current.nonce, current.id).catch(showError);
	});
	details.append(summary, facts, note, copy, dismiss);
	return {
		details,
		update: (next: TeamAgent, value: ResponseView) => {
			current = value;
			summary.textContent = `${next.name}: ${responseFact(value)}`;
			facts.textContent = responseFacts(value).join('\n');
		},
	};
}

/** Opening delivery details never selects a terminal or transfers focus to provider input. */
export function setupResponsePanel(anchor: HTMLElement, showError: (error: unknown) => void) {
	if (!anchor.hasAttribute('tabindex')) anchor.tabIndex = -1;
	const section = document.createElement('section');
	section.className = 'response-watchdog';
	section.setAttribute('aria-label', 'Delivery response');
	section.hidden = true;
	const announcements = document.createElement('span');
	announcements.setAttribute('role', 'status');
	announcements.className = 'response-announcement';
	section.append(announcements);
	anchor.insertAdjacentElement('afterend', section);
	const items = new Map<string, ReturnType<typeof responseItem>>();
	return (agents: TeamAgent[]) => {
		const keep = new Set<string>();
		const added: string[] = [];
		let attentionCount = 0;
		for (const agent of agents) {
			const state = agent.responseWatchdog;
			if (!state || state.phase !== 'attention') continue;
			attentionCount++;
			const key = `${agent.slug}:${state.id}`;
			keep.add(key);
			let item = items.get(key);
			if (!item) {
				item = responseItem(agent, state, showError);
				items.set(key, item);
				added.push(agent.name);
				section.append(item.details);
			}
			item.update(agent, state);
		}
		let restoreFocus = false;
		for (const [key, item] of items) {
			if (keep.has(key)) continue;
			if (item.details.contains(document.activeElement)) restoreFocus = true;
			item.details.remove();
			items.delete(key);
		}
		section.hidden = attentionCount === 0;
		if (restoreFocus) (section.querySelector('summary') ?? anchor).focus();
		if (added.length)
			announcements.textContent = `Missing read confirmation: ${added.join(', ')}. Open delivery details to inspect.`;
	};
}
