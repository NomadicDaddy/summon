import type { NotificationPauseView } from './notification-pause.ts';

/** How often the remaining time is redrawn. The value shown is whole seconds, so this is enough. */
const TICK = 500;

/**
 * The quiet-time control, beside the other things the operator does to the selected teammate.
 *
 * It exists because looking at a teammate used to pause it silently and indefinitely: there is no
 * un-looking at someone, so whoever was last selected stayed quiet with nothing on screen saying so
 * (#4573). The fix is not a different timing rule, it is that the pause became visible and
 * releasable.
 *
 * THREE STATES, and the button says which one it is in:
 *
 *   not paused   "Hold Interruptions"    pressing pins a pause
 *   automatic    "Interruptions Held · 27s"   the quiet period after switching, counting down
 *   pinned       "Interruptions Held"    the operator asked for it; no countdown, it does not lapse
 *
 * A FOURTH STATE, WHICH IS NOT THIS CONTROL'S TO CHANGE (#5428):
 *
 *   heads-down   "Interruptions Queued"   not pressable; head-down owns the answer
 *
 * While a teammate is heads-down the backend queues its notices whatever this button says
 * (automatic-interruptions.ts holds them for an operator's quiet time OR an active head-down). So
 * the button went on reading "Hold Interruptions" over a teammate whose interruptions were already
 * held, and pressing it pinned a second pause that did nothing visible and was still there, pinned
 * and forgotten, when head-down ended. It now says what is true and where to change it. It stays
 * focusable and keeps its tooltip - aria-disabled rather than disabled - because a control that
 * cannot be used owes the reader the reason, and a disabled button gives up its tooltip.
 *
 * THE WORDING SAYS WHICH DIRECTION IT RUNS, because the old wording did not and I misread my own
 * control because of it. "Hold notifications for this teammate" reads equally as notices FROM them
 * and notices TO them; what it does is stop room and mail notices INTERRUPTING THEM while the
 * operator works with them. Phillip asked for the change at #4848 after my wrong account at #4846.
 * The visible label carries it too, not just the tooltip: the label is the accessible name, so a
 * screen reader announces it and never reads the title at all.
 *
 * The countdown ticks from `until` locally rather than waiting for snapshots, because a number that
 * advances in jumps reads as broken rather than as a timer.
 *
 * THE ACCESSIBLE NAME IS THE ACTION, NOT THE NUMBER. A name that changes every second is announced
 * every second, which would make the control unusable with a screen reader for the sake of a detail
 * that is decoration beside the decision. The name says what pressing it will do; the remaining
 * time is hidden from assistive technology and present for the eye.
 */
export function setupNotificationPause(
	onError: (error: unknown) => void,
): (view: NotificationPauseView | undefined, hasSelection: boolean, headsDown: boolean) => void {
	const node = document.getElementById('notification-pause');
	if (!(node instanceof HTMLButtonElement)) throw new Error('Missing notification-pause element');
	const label = document.createElement('span');
	const remaining = document.createElement('span');
	remaining.className = 'pause-remaining';
	remaining.setAttribute('aria-hidden', 'true');
	node.replaceChildren(label, remaining);

	let state: NotificationPauseView | undefined;
	let queued = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	const seconds = (until: number): number => Math.max(0, Math.ceil((until - Date.now()) / 1000));

	const paint = (): void => {
		const view = state;
		node.classList.toggle('is-queued', queued);
		if (queued) node.setAttribute('aria-disabled', 'true');
		else node.removeAttribute('aria-disabled');
		if (queued) {
			label.textContent = 'Interruptions Queued';
			remaining.textContent = '';
			node.classList.remove('is-paused');
			// Not a toggle in this state, so it must not announce itself as a pressed one.
			node.removeAttribute('aria-pressed');
			node.title =
				'This teammate is heads-down, so room and mail notices are queued until that ends. End head-down in the bar below to let them through.';
			return;
		}
		if (!view?.paused) {
			label.textContent = 'Hold Interruptions';
			remaining.textContent = '';
			node.classList.remove('is-paused');
			node.setAttribute('aria-pressed', 'false');
			node.title =
				'Stop room and mail notices interrupting this teammate while you work with them';
			return;
		}
		node.classList.add('is-paused');
		node.setAttribute('aria-pressed', 'true');
		label.textContent = 'Interruptions Held';
		if (view.manual) {
			remaining.textContent = '';
			node.title =
				'Room and mail notices are not interrupting this teammate. Press to let them through.';
			return;
		}
		const left = view.until === undefined ? 0 : seconds(view.until);
		remaining.textContent = ` · ${String(left)}s`;
		node.title = `Room and mail notices will not interrupt this teammate for another ${String(left)} seconds. Press to let them through now.`;
	};

	/* A ticker only while something is counting: a pinned pause and an idle window have nothing to
	 * redraw, and a timer that runs anyway is a wakeup every half-second for no one. */
	const ticking = (wanted: boolean): void => {
		if (wanted && timer === undefined) timer = setInterval(paint, TICK);
		if (!wanted && timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	node.addEventListener('click', () => {
		// Head-down owns the answer while it is active; a press here would pin a pause nobody sees.
		if (queued) return;
		// Pressing while paused resumes, whichever kind of pause it is; pressing while live pins one.
		void window.team.pauseNotifications(!state?.paused).catch(onError);
	});

	return (view, hasSelection, headsDown): void => {
		node.hidden = !hasSelection;
		state = view;
		queued = headsDown;
		ticking(
			hasSelection && !queued && !!view?.paused && !view.manual && view.until !== undefined,
		);
		paint();
	};
}
