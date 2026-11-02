import { noteConfirmedWrite, noteUnconfirmedWrite, PERSISTENCE_SOURCE } from './fault-report.ts';

/**
 * Which teammates have had something go wrong that the operator has not yet seen.
 *
 * An error about a teammate who is not on screen has nowhere to live. Phillip mentioned Edgar in
 * the room; the mention woke him; the wake failed because this window does not own his session; and
 * the resulting alert appeared under MORGAN's header, contradicting Morgan's own status line
 * (#4924). The room had not failed, so the room's own error slot was not involved, and Edgar had no
 * pane, no panel and no row of his own that said anything.
 *
 * The banner now names the teammate. This marks the teammate, so the name has somewhere to point.
 *
 * CLEARING IS THE WHOLE DESIGN, and my first attempt at it was wrong in a way worth recording.
 * I proposed clearing when a later snapshot showed the teammate running. Morgan's correction: most
 * faults arrive ABOUT a teammate the roster already believes is running - the wake failure above is
 * exactly that - so the marker would have appeared and vanished on the next snapshot, before anyone
 * could look at it. A marker that erases itself is worse than none, because it teaches the operator
 * that the roster is not worth checking.
 *
 * So a fault clears on one of two things, both of which mean the condition is genuinely over:
 *
 *   the operator SAW it - selecting the teammate shows the detail, and the clear follows the
 *   showing rather than the click, so looking is what dismisses it
 *
 *   the teammate TRANSITIONED into running after the fault arrived - not merely "is running now",
 *   which was already true when it arrived and proves nothing
 */
export interface Fault {
	/** When it arrived, so a later transition can be compared against it. */
	at: number;
	message: string;
	/** Set once the operator has been shown it; the clear happens after the showing. */
	seen: boolean;
}

export interface FaultStore {
	/** Record a fault against a teammate. A newer one replaces an unseen older one. */
	add: (slug: string, message: string, now?: number) => void;
	/** The fault to show for a teammate, or undefined. */
	get: (slug: string) => Fault | undefined;
	/** Slugs currently marked. */
	marked: () => string[];
	/** The operator has been shown this one; it goes. */
	sawIt: (slug: string) => void;
	/**
	 * Fold in a snapshot's statuses. A teammate that was not running and now is has recovered, so
	 * any fault recorded BEFORE that transition goes with it.
	 */
	sync: (statuses: Map<string, string>, now?: number) => void;
}

/*
 * Recovery is 'running' alone, and deliberately not 'elsewhere'.
 *
 * A wake fails BECAUSE the session is owned by another window, which is what elsewhere means. So
 * treating a move into elsewhere as recovery would clear the fault on the very condition that
 * caused it - the mark would vanish exactly when it was most accurate.
 */
const RECOVERED = 'running';

export function faultStore(): FaultStore {
	const faults = new Map<string, Fault>();
	/* Last seen status per teammate, so "transitioned into running" can be told from "is running",
	   which is the distinction the whole clearing rule rests on. */
	let previous = new Map<string, string>();

	return {
		add: (slug, message, now = Date.now()) => {
			faults.set(slug, { at: now, message, seen: false });
		},
		get: (slug) => faults.get(slug),
		marked: () => [...faults.keys()],
		sawIt: (slug) => {
			faults.delete(slug);
		},
		sync: (statuses, now = Date.now()) => {
			for (const [slug, status] of statuses) {
				const fault = faults.get(slug);
				const was = previous.get(slug);
				// Only a transition counts: it must have been something else before.
				if (fault && was !== undefined && was !== RECOVERED && status === RECOVERED)
					if (fault.at <= now) faults.delete(slug);
			}
			previous = new Map(statuses);
		},
	};
}

/**
 * Mark a roster row, and make looking at it the thing that dismisses the mark.
 *
 * The mark goes on the row rather than into the row's status text: the status is what the teammate
 * itself reports, and a fault is what happened TO it. Writing one over the other is how a banner
 * came to contradict a header in the first place (#4924).
 *
 * `select` runs before the detail is shown on purpose. The window hides the error box as the first
 * act of any action, so showing the detail first would flash it away in the same tick.
 */
export function markFaultedRow(
	button: HTMLElement,
	slug: string,
	faults: FaultStore,
	// `display`, not `show`: recording this fault was already attempted when it arrived.
	show: (message: string) => void,
	select: () => Promise<boolean>,
): void {
	const fault = faults.get(slug);
	if (fault) {
		button.classList.add('has-fault');
		button.title = fault.message;
	}
	button.addEventListener('click', () => {
		void (async () => {
			// A selection that failed is not a viewing. The window reports its own failure, and
			// treating it as "seen" would discard the fault the operator never got to.
			if (!(await select())) return;
			if (!fault) return;
			show(fault.message);
			/*
			 * Clear THE FAULT THAT WAS SHOWN, not whatever is stored now. This handler captured its
			 * fault when the row was drawn, and a newer one can arrive during the await - clearing
			 * by slug alone would silently discard a fault nobody has seen.
			 */
			if (faults.get(slug) === fault) faults.sawIt(slug);
		})();
	});
}

/**
 * Show an error, and mark the teammate when it names one.
 *
 * An error with no slug is window-level and marks nobody - a shutdown failure or a malformed
 * record belongs to the window, not to a teammate, and giving it one would be inventing a subject.
 */
export function noteFault(
	faults: FaultStore,
	event: {
		diagnosticHandled?: boolean;
		diagnosticSaved?: boolean;
		message: string;
		slug?: string;
		source?: string;
	},
	banner: {
		display: (text: string) => void;
		show: (error: unknown, source?: string, member?: string) => void;
	},
	redraw: () => void,
): void {
	// The journal's own unconfirmed write opens the notice episode before the banner draws it, so
	// the error that prompted the write can take the banner next without taking the notice. A
	// main record the journal did save closes the episode; one it could not save (`diagnosticSaved`
	// false) or one that says nothing leaves the notice as it is.
	if (event.source === PERSISTENCE_SOURCE) noteUnconfirmedWrite(event.source);
	else if (event.diagnosticSaved === true) noteConfirmedWrite();
	// Main already attempted recording, successfully or not. Only an unhandled event is this
	// window's to report, and then under the teammate it names.
	if (event.diagnosticHandled) banner.display(event.message);
	else banner.show(event.message, 'team.event', event.slug);
	if (!event.slug) return;
	faults.add(event.slug, event.message);
	redraw();
}
