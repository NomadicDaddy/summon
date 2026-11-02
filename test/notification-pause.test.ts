import { expect, test } from 'bun:test';

import { notificationPause } from '../src/desktop/notification-pause.ts';

test('stopped sessions cannot pause; starting enables quiet time and exiting clears it', () => {
	let now = 1000;
	const pause = notificationPause(() => now);
	pause.select('alpha', false);
	pause.terminalInput('alpha', true);
	pause.set(true);
	expect(pause.view()).toEqual({ paused: false, manual: false });
	pause.select('alpha', true);
	expect(pause.view().until).toBe(31000);
	pause.set(true);
	pause.select('alpha', false);
	expect(pause.view()).toEqual({ paused: false, manual: false });
	now = 5000;
	pause.select('alpha', true);
	expect(pause.view().until).toBe(35000);
	pause.select('beta', false);
	expect(pause.view()).toEqual({ paused: false, manual: false });
});

test('selection pauses for 30 seconds and repeated snapshots cannot extend it', () => {
	let now = 1000;
	const pause = notificationPause(() => now);
	pause.select('alpha', true);
	expect(pause.view()).toEqual({ paused: true, manual: false, until: 31000 });
	now = 20000;
	pause.select('alpha', true);
	expect(pause.view().until).toBe(31000);
	now = 31000;
	expect(pause.view()).toEqual({ paused: false, manual: false });
	pause.select('alpha', true);
	expect(pause.view().paused).toBe(false);
	pause.select('beta', true);
	expect(pause.view().until).toBe(61000);
});

test('human typing renews only the selected teammate quiet period', () => {
	let now = 0;
	const pause = notificationPause(() => now);
	pause.select('alpha', true);
	now = 29000;
	pause.terminalInput('beta', true);
	expect(pause.view().until).toBe(30000);
	pause.terminalInput('alpha', true);
	expect(pause.view().until).toBe(59000);
	now = 59000;
	expect(pause.view().paused).toBe(false);
});

test("only human input in the teammate's terminal renews its hold (Phillip #13984)", () => {
	let now = 0;
	const pause = notificationPause(() => now);
	pause.select('alpha', true);
	now = 20000;
	// A terminal's own focus, mouse and query replies arrive marked as not human.
	pause.terminalInput('alpha', false);
	expect(pause.view().until).toBe(30000);
	now = 30000;
	pause.terminalInput('alpha', false);
	expect(pause.view()).toEqual({ paused: false, manual: false });
	pause.terminalInput('alpha', true);
	expect(pause.view().until).toBe(60000);
});

test('the policy sets the automatic window length and can turn it off (Phillip #7266)', () => {
	let now = 0;
	let policy = { autoHold: true, holdMs: 10_000 };
	const pause = notificationPause(
		() => now,
		() => policy,
	);
	pause.select('alpha', true);
	expect(pause.view()).toEqual({ paused: true, manual: false, until: 10000 });
	now = 4000;
	pause.terminalInput('alpha', true);
	expect(pause.view().until).toBe(14000);
	// Turning the automatic hold off releases the running countdown at once, and reading the
	// policy again never renews it; the next selection or keystroke holds nothing...
	policy = { autoHold: false, holdMs: 10_000 };
	expect(pause.view()).toEqual({ paused: false, manual: false });
	policy = { autoHold: true, holdMs: 10_000 };
	expect(pause.view()).toEqual({ paused: true, manual: false, until: 14000 });
	policy = { autoHold: false, holdMs: 10_000 };
	pause.select('beta', true);
	expect(pause.view()).toEqual({ paused: false, manual: false });
	pause.terminalInput('beta', true);
	expect(pause.view()).toEqual({ paused: false, manual: false });
	// ...while the pinned hold still works, and switching still drops it.
	pause.set(true);
	expect(pause.view()).toEqual({ paused: true, manual: true });
	pause.select('alpha', true);
	expect(pause.view()).toEqual({ paused: false, manual: false });
	// Turning it back on with a new length applies from the next renewal.
	policy = { autoHold: true, holdMs: 60_000 };
	now = 5000;
	pause.terminalInput('alpha', true);
	expect(pause.view().until).toBe(65000);
});

test('explicit toggle holds or releases the selected pause; switching clears that hold', () => {
	let now = 0;
	const pause = notificationPause(() => now);
	pause.select('alpha', true);
	pause.set(false);
	expect(pause.view()).toEqual({ paused: false, manual: false });
	pause.set(true);
	now = 100000;
	pause.terminalInput('alpha', true);
	expect(pause.view()).toEqual({ paused: true, manual: true });
	pause.select('beta', true);
	expect(pause.view()).toEqual({ paused: true, manual: false, until: 130000 });
	pause.select('', false);
	pause.set(true);
	expect(pause.view()).toEqual({ paused: false, manual: false });
});
