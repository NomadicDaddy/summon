/**
 * A label whose letters light up one after another while something is in progress (Phillip #8406,
 * approved #8419): the word stays where it is, one letter takes the colour of the busy dot for a moment,
 * then the next. It says "still going" without moving anything around it.
 *
 * The timing comes from the clock, not from when the label was drawn. The roster rebuilds its rows
 * on every status update, and an animation that started over each time would stutter on the first
 * letters; a negative delay puts each letter at the point in the sweep the clock says it has
 * reached, so a rebuilt row carries on and the roster and the session header stay in step.
 */

/** How long the highlight takes to move on to the next letter. */
export const SWEEP_STEP_MS = 90;
/** Letters' worth of rest between one pass and the next. */
const SWEEP_REST_STEPS = 4;

/** One full pass, rest included, for a label of this many letters. */
export function sweepPeriod(letters: number): number {
	return (letters + SWEEP_REST_STEPS) * SWEEP_STEP_MS;
}

/**
 * The animation delay for one letter: never positive, so the letter starts part-way through its
 * cycle at the point the clock has reached rather than waiting for its turn from zero.
 */
export function sweepDelay(index: number, letters: number, now: number): number {
	const period = sweepPeriod(letters);
	const elapsed = (((now - index * SWEEP_STEP_MS) % period) + period) % period;
	return elapsed === 0 ? 0 : -elapsed;
}

/**
 * Write `text` into `element`, swept when `active` and plain otherwise. The text content is the
 * same either way, and assistive technology is given the word once, not letter by letter.
 *
 * A swept label is redrawn on every call, even with the same text. An animation's delay counts
 * from when the animation started, so a running one cannot be put back on the clock by changing
 * its delay, and one that restarted because its element was hidden and shown again would carry on
 * from where it was first drawn (Morticia #8450). Fresh letters start now, at the clock's phase.
 */
export function setSweptLabel(element: HTMLElement, text: string, active: boolean): void {
	if (!active) {
		if (element.classList.contains('letter-sweep') || element.textContent !== text) {
			element.classList.remove('letter-sweep');
			element.removeAttribute('aria-label');
			element.removeAttribute('role');
			element.textContent = text;
		}
		return;
	}
	const letters = Array.from(text);
	const now = Date.now();
	element.classList.add('letter-sweep');
	element.setAttribute('role', 'img');
	element.setAttribute('aria-label', text);
	element.style.setProperty('--sweep-period', `${String(sweepPeriod(letters.length))}ms`);
	element.replaceChildren(
		...letters.map((letter, index) => {
			const span = document.createElement('span');
			span.setAttribute('aria-hidden', 'true');
			span.textContent = letter;
			span.style.animationDelay = `${String(sweepDelay(index, letters.length, now))}ms`;
			return span;
		}),
	);
}
