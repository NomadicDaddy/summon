import type { TeamAgent } from './types.ts';

/**
 * A pending head-down request, answerable beside the row it belongs to.
 *
 * It sits OUTSIDE the member button rather than inside it, the way the rest control does, because
 * the row is itself a button and a button inside a button is neither valid nor clickable. That
 * constraint is also the right answer here: approving a request is not selecting a teammate, and
 * the two should not share a hit area.
 *
 * Nothing about the dot changes. A request is a question waiting for an answer, not a state the
 * session is in - the teammate is still running or idle or stopped underneath, and the roster has
 * to keep saying which.
 */
export function headDownRosterRow(
	agent: TeamAgent,
	member: HTMLElement,
	decide: (slug: string, id: string, approve: boolean) => void,
): HTMLElement {
	const pending = agent.headDown;
	if (pending?.phase !== 'requested') return member;
	const row = document.createElement('div');
	row.className = 'head-down-row';
	const ask = document.createElement('span');
	ask.className = 'head-down-ask';
	for (const [label, approve, title] of [
		['Yes', true, `Approve head-down for ${agent.name}: ${pending.goal}`],
		['No', false, `Decline head-down for ${agent.name}`],
	] as const) {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = label;
		button.title = title;
		button.className = approve ? 'approve' : '';
		button.dataset.headDownSlug = agent.slug;
		button.dataset.headDownDecision = approve ? 'approve' : 'decline';
		button.setAttribute('aria-label', title);
		button.addEventListener('click', () => {
			decide(agent.slug, pending.id, approve);
		});
		ask.append(button);
	}
	row.append(member, ask);
	return row;
}

export interface HeadDownFocus {
	decision: string;
	slug: string;
}

/**
 * Which head-down answer has keyboard focus, read before the roster is rebuilt. The roster redraws
 * on every changed snapshot, and member and rest buttons already survive that; without this, a
 * keyboard user on Yes or No dropped to <body> whenever any teammate changed state.
 */
export function focusedHeadDown(roster: HTMLElement): HeadDownFocus | undefined {
	const active = document.activeElement;
	if (!(active instanceof HTMLElement) || !roster.contains(active)) return undefined;
	const { headDownDecision: decision, headDownSlug: slug } = active.dataset;
	return decision && slug ? { decision, slug } : undefined;
}

/** Put focus back on the same answer, or on the teammate's row once the request has gone. */
export function restoreHeadDownFocus(roster: HTMLElement, focus: HeadDownFocus | undefined): void {
	if (!focus) return;
	const buttons = [...roster.querySelectorAll<HTMLElement>('button[data-head-down-slug]')];
	const answer = buttons.find(
		(button) =>
			button.dataset.headDownSlug === focus.slug &&
			button.dataset.headDownDecision === focus.decision,
	);
	const member = [...roster.querySelectorAll<HTMLElement>('[data-slug]')].find(
		(button) => button.dataset.slug === focus.slug,
	);
	(answer ?? member)?.focus({ preventScroll: true });
}
