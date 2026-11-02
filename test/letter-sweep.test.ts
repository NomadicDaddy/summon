import { expect, test } from 'bun:test';

import { SWEEP_STEP_MS, sweepDelay, sweepPeriod } from '../src/desktop/letter-sweep.ts';

/*
 * The timing of the "Compacting…" letter sweep (#8406). The drawing is DOM and CSS and is verified
 * in the built window (summon has no DOM in bun:test); what can be held here is the arithmetic
 * that keeps a redrawn row in step with the clock.
 */
const letters = Array.from('Compacting…').length;

test('a pass lasts one step per letter plus a rest', () => {
	expect(letters).toBe(11);
	expect(sweepPeriod(letters)).toBe(15 * SWEEP_STEP_MS);
});

test('a delay is never positive and always inside one pass', () => {
	const period = sweepPeriod(letters);
	for (const now of [0, 1, 89, 90, 1349, 1350, 1_760_000_000_123]) {
		for (let index = 0; index < letters; index++) {
			const delay = sweepDelay(index, letters, now);
			expect(delay).toBeLessThanOrEqual(0);
			expect(delay).toBeGreaterThan(-period);
		}
	}
});

test('each letter runs one step behind the letter before it', () => {
	const now = 1_760_000_000_000;
	const period = sweepPeriod(letters);
	const phase = (index: number): number => -sweepDelay(index, letters, now);
	for (let index = 1; index < letters; index++) {
		expect((phase(index - 1) - phase(index) + period) % period).toBe(SWEEP_STEP_MS);
	}
});

test('a label drawn later picks up where the clock is, not from the start', () => {
	const period = sweepPeriod(letters);
	const first = -sweepDelay(3, letters, 1_000_000);
	const later = -sweepDelay(3, letters, 1_000_000 + 400);
	expect((later - first + period) % period).toBe(400);
	expect(sweepDelay(3, letters, 1_000_000 + period)).toBe(sweepDelay(3, letters, 1_000_000));
});
