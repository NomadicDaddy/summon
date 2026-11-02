import { expect, test } from 'bun:test';

import { createResponseClock } from '../src/response-watchdog-clock.ts';

test('elapsed time is monotonic; wall jumps restart instead of inventing a timeout', () => {
	const clock = createResponseClock();
	expect(clock(undefined, 1000000, 0)).toEqual({ now: 1000000, reset: false });
	expect(clock(1000000, 1299999, 300000)).toEqual({ now: 1300000, reset: false });
	expect(clock(1300000, 5000000, 300001)).toEqual({ now: 5000000, reset: true });
	expect(clock(5000000, 4000000, 300002).reset).toBe(true);
});

test('same-launch restart retains a bounded elapsed window, unreasonable gaps restart', () => {
	expect(createResponseClock()(1000000, 1600000, 0).reset).toBe(false);
	expect(createResponseClock()(1000000, 999999, 0).reset).toBe(true);
	expect(createResponseClock()(1000000, 100000000, 0).reset).toBe(true);
});
