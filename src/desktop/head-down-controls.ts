import type { TeamAgent } from './types.ts';

import { headDownEditorKey } from './head-down-row.ts';

/**
 * The bar under the toolbar: what the selected teammate agreed to, and where a live request is
 * answered or a live head-down ended.
 *
 * Head-down is deliberately absent from the roster as an action. The roster answers which teammates
 * are in it and whether their sessions are alive, which is a scanning job; approving, ending, or
 * granting someone the power to approve are deliberate acts about one teammate, and those belong
 * where the other per-teammate actions already are.
 *
 * Completion shows here rather than in the roster for the same reason it is not a roster state: it
 * is the condition the operator agreed to, so it belongs beside the decision rather than in a
 * column being scanned for liveness.
 *
 * DELEGATION IS NOT PART OF THIS BAR, and that placement was a correction. It first sat here, where
 * the bar only exists while a request or an active head-down does - so the permission could never
 * be granted before the first request, which is the only moment it is any use. It is a standing
 * authority the operator gives a teammate, which is what Summon, Stop and Hibernate already are, so
 * it lives with them and follows Hibernate's shape: one button whose label states what pressing it
 * will do.
 */
export function setupHeadDownControls(
	onError: (error: unknown) => void,
): (agent: TeamAgent | undefined) => void {
	const get = (id: string): HTMLElement => {
		const node = document.getElementById(id);
		if (!node) throw new Error(`Missing head-down element ${id}`);
		return node;
	};
	const bar = get('head-down-bar');
	const goal = get('head-down-goal');
	const approve = get('head-down-approve') as HTMLButtonElement;
	const decline = get('head-down-decline') as HTMLButtonElement;
	const end = get('head-down-end') as HTMLButtonElement;
	const reason = get('head-down-reason') as HTMLInputElement;
	const confirm = get('head-down-end-confirm') as HTMLButtonElement;
	const cancel = get('head-down-end-cancel') as HTMLButtonElement;
	const delegate = get('head-down-delegate') as HTMLButtonElement;
	let selected: TeamAgent | undefined;
	let editorKey = '';

	for (const [button, decision] of [
		[approve, true],
		[decline, false],
	] as const)
		button.addEventListener('click', () => {
			const pending = selected?.headDown;
			if (!selected || pending?.phase !== 'requested') return;
			void window.team.headDownDecision(selected.slug, pending.id, decision).catch(onError);
		});

	/*
	 * Ending asks for its reason IN THE BAR, and the first version asked with window.prompt - which
	 * Electron does not implement, so that control could never have worked in any build. It was
	 * written and shipped without the click ever being performed; the probe had measured the bar
	 * around it and proved nothing about the button inside it.
	 *
	 * In place is also the better answer. The goal being ended stays on screen while its reason is
	 * written, and the whole exchange is reachable by keyboard and testable by clicking it.
	 */
	const asking = (open: boolean): void => {
		reason.hidden = !open;
		confirm.hidden = !open;
		cancel.hidden = !open;
		end.hidden = open || selected?.headDown?.phase !== 'active';
		if (open) {
			reason.value = 'Ended by the operator';
			reason.focus();
			reason.select();
			return;
		}
		// Closing EMPTIES it rather than only hiding it. Reopening would overwrite the text anyway,
		// so this changes nothing that can be submitted - but a discarded reason about one teammate's
		// goal has no business sitting in the field, readable, while another teammate is selected.
		reason.value = '';
	};
	end.addEventListener('click', () => {
		if (selected?.headDown?.phase !== 'active') return;
		asking(true);
	});
	cancel.addEventListener('click', () => {
		asking(false);
	});
	const finish = (): void => {
		const active = selected?.headDown;
		if (!selected || active?.phase !== 'active') return;
		const given = reason.value.trim();
		// An empty reason is not recorded. The field keeps focus so it is obvious what is wanted.
		if (!given) {
			reason.focus();
			return;
		}
		asking(false);
		// Ending returns the teammate to normal delivery; it does not stop the session.
		void window.team.headDownEnd(selected.slug, active.id, given).catch(onError);
	};
	confirm.addEventListener('click', finish);
	reason.addEventListener('keydown', (event: KeyboardEvent) => {
		if (event.key === 'Enter') finish();
		if (event.key === 'Escape') asking(false);
	});

	delegate.addEventListener('click', () => {
		if (!selected) return;
		const granting = !selected.canManageHeadDown;
		if (
			granting &&
			!window.confirm(
				`Let ${selected.name} approve OTHER teammates' requests to go head-down?\n\nThis is not permission for ${selected.name} to go head-down - every teammate can already ask for that. It grants nothing else either: not held mail, not any other authority.`,
			)
		)
			return;
		void window.team.headDownDelegate(selected.slug, granting).catch(onError);
	});

	return (agent: TeamAgent | undefined): void => {
		selected = agent;
		const state = agent?.headDown;
		const requested = state?.phase === 'requested' ? state : undefined;
		const active = state?.phase === 'active' ? state : undefined;
		bar.hidden = !agent || (!requested && !active);
		bar.classList.toggle('overdue', !!active?.overdue && agent?.status !== 'exited');
		approve.hidden = !requested;
		decline.hidden = !requested;
		/*
		 * A DRAFT REASON BELONGS TO ONE GOAL and never outlives it. Closing only when head-down
		 * went away missed the case that costs something: switching between two teammates who are
		 * both in head-down keeps the phase active throughout, so a reason typed about the first
		 * stayed on screen over the second, and would have ended it with another goal's words.
		 */
		const key = headDownEditorKey(agent?.slug, state);
		if (key !== editorKey) {
			editorKey = key;
			asking(false);
		}
		end.hidden = !active || !reason.hidden;
		/*
		 * A STATE LABEL THAT DOES NOT CHANGE, the shape Phillip chose at #4647.
		 *
		 * It read as "Allow Head-down Approvals" and was twice unclear (#4642, #4643): the plural
		 * suggested several approvals to allow, and sitting in a row where every other button acts
		 * ON the selected teammate, it was taken to mean "this teammate may go head-down". It means
		 * the opposite direction - this teammate may approve OTHERS.
		 *
		 * So the text now states the standing fact rather than the next action, and whether it is
		 * on is carried by aria-pressed and the lit treatment, the same way the thumbs-up and the
		 * pause control already work here. The title says what pressing will do, and what the
		 * permission does NOT extend to, because that is the part a one-line label cannot hold.
		 */
		delegate.hidden = !agent;
		const granted = agent?.canManageHeadDown ?? false;
		delegate.textContent = 'Can Approve Heads-down';
		delegate.setAttribute('aria-pressed', String(granted));
		delegate.classList.toggle('is-granted', granted);
		const who = agent?.name ?? 'this teammate';
		delegate.title = granted
			? `${who} can approve other teammates' requests to go head-down. Press to withdraw it.`
			: `Press to let ${who} approve other teammates' requests to go head-down. It grants nothing else - not held mail, not any other authority.`;
		if (requested)
			goal.textContent = `Asking to go head-down: ${requested.goal} — done when ${requested.completion}`;
		else if (active)
			goal.textContent = [
				active.overdue ? 'Head-down, HEARTBEAT OVERDUE:' : 'Head-down:',
				active.goal,
				`— done when ${active.completion}`,
				active.approvedBy ? `(approved by ${active.approvedBy})` : '',
			]
				.filter(Boolean)
				.join(' ');
		else goal.textContent = '';
		goal.title = goal.textContent;
	};
}
