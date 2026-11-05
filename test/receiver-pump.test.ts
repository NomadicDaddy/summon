import { expect, test } from 'bun:test';

import { nextLocalRoomWakeAt } from '../src/local-room-live.ts';
import { RECEIVER_FALLBACK_MS, telegramPollInterval } from '../src/receiver-cadence.ts';
import { createReceiverPump, type ReceiverClock } from '../src/receiver-pump.ts';
import { nextTelegramRoomWakeAt } from '../src/telegram-live.ts';

function controlledClock() {
	let now = 0;
	let nextId = 0;
	const timers = new Map<number, { at: number; callback: () => void; interval?: number }>();
	const clock: ReceiverClock = {
		now: () => now,
		setTimeout: (callback, delay) => {
			const id = ++nextId;
			timers.set(id, { at: now + delay, callback });
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout: (timer) => {
			timers.delete(Number(timer));
		},
		setInterval: (callback, delay) => {
			const id = ++nextId;
			timers.set(id, { at: now + delay, callback, interval: delay });
			return id as unknown as ReturnType<typeof setInterval>;
		},
		clearInterval: (timer) => {
			timers.delete(Number(timer));
		},
	};
	return {
		clock,
		advance: async (at: number) => {
			for (;;) {
				const due = [...timers.entries()]
					.filter(([, timer]) => timer.at <= at)
					.sort((left, right) => left[1].at - right[1].at)
					.at(0);
				if (!due) break;
				now = due[1].at;
				timers.delete(due[0]);
				if (due[1].interval) timers.set(due[0], { ...due[1], at: now + due[1].interval });
				due[1].callback();
				await Bun.sleep(1);
			}
			now = at;
			await Bun.sleep(1);
		},
		pendingAlarms: () => [...timers.values()].filter((timer) => !timer.interval).length,
		pending: () => timers.size,
	};
}

test('lost watches get a bounded scan; a file event wakes at once', async () => {
	const time = controlledClock();
	let scans = 0;
	const errors: unknown[] = [];
	const pump = createReceiverPump(
		() => {
			scans++;
			return Promise.resolve();
		},
		() => Promise.resolve(undefined),
		(error) => {
			errors.push(error);
			return Promise.resolve();
		},
		time.clock,
	);
	pump.schedule();
	await time.advance(0);
	for (let at = RECEIVER_FALLBACK_MS; at <= 60_000; at += RECEIVER_FALLBACK_MS) {
		await time.advance(at - 1);
		expect(scans).toBe(at / RECEIVER_FALLBACK_MS);
		await time.advance(at);
	}
	expect(scans).toBe(7); // Initial + six scans, versus initial + thirty at two seconds.
	await time.advance(60_123);
	pump.schedule(); // A native event does not wait for the next fallback.
	await time.advance(60_123);
	expect(scans).toBe(8);
	await pump.stop();
	expect(errors).toHaveLength(0);
});

test('one busy cycle coalesces a burst and keeps its exact retry deadline', async () => {
	const time = controlledClock();
	let finishFirst: (() => void) | undefined;
	const first = new Promise<void>((resolve) => {
		finishFirst = resolve;
	});
	let scans = 0;
	let retryAt = 2_000;
	const errors: unknown[] = [];
	const pump = createReceiverPump(
		async () => {
			scans++;
			if (scans === 1) await first;
		},
		() => Promise.resolve(retryAt),
		(error) => {
			errors.push(error);
			return Promise.resolve();
		},
		time.clock,
	);
	pump.schedule();
	await time.advance(0);
	pump.schedule();
	pump.schedule();
	expect(scans).toBe(1);
	finishFirst?.();
	await time.advance(1);
	expect(scans).toBe(2);
	expect(time.pendingAlarms()).toBe(1);
	await time.advance(1_999);
	expect(scans).toBe(2);
	retryAt = 0;
	await time.advance(2_000);
	expect(scans).toBe(3);
	await pump.stop();
	expect(time.pending()).toBe(0);
	expect(errors).toHaveLength(0);
});

test('a deadline crossed during a busy cycle gets one prompt follow-up', async () => {
	const time = controlledClock();
	let finishFirst: (() => void) | undefined;
	const first = new Promise<void>((resolve) => {
		finishFirst = resolve;
	});
	let scans = 0;
	const deadline = 3_000;
	const pump = createReceiverPump(
		async () => {
			scans++;
			if (scans === 1) await first;
		},
		(cycleStartedAt) => Promise.resolve(deadline > cycleStartedAt ? deadline : undefined),
		(error) => {
			throw error;
		},
		time.clock,
	);
	pump.schedule();
	await time.advance(0);
	await time.advance(deadline + 1);
	expect(scans).toBe(1);
	finishFirst?.();
	await time.advance(deadline + 1);
	await time.advance(deadline + 2);
	expect(scans).toBe(2);
	expect(time.pendingAlarms()).toBe(0);
	await time.advance(deadline + 3);
	expect(scans).toBe(2);
	await pump.stop();
});

test('seat poll jitter separates contenders without extending the local fallback', () => {
	expect(telegramPollInterval(0)).toBe(3_000);
	expect(telegramPollInterval(0.5)).toBe(4_000);
	expect(telegramPollInterval(0.999)).toBe(4_998);
	expect(RECEIVER_FALLBACK_MS).toBe(10_000);
});

test('three quiet seats make fewer shared poll and lock attempts than the two-second cadence', () => {
	const count = (intervals: number[]) => {
		const checks = intervals
			.flatMap((interval) => {
				const times: number[] = [];
				for (let at = interval; at <= 60_000; at += interval) times.push(at);
				return times;
			})
			.sort((left, right) => left - right);
		let polledAt = 0;
		let locks = 0;
		for (const at of checks) {
			if (at - polledAt < 2_000) continue; // syncTelegram's durable throttle.
			locks++;
			polledAt = at; // It is saved before the API request, including on outage.
		}
		return { checks: checks.length, locks };
	};
	const baseline = count([2_000, 2_000, 2_000]);
	const pollOnly = count([
		telegramPollInterval(0),
		telegramPollInterval(0.5),
		telegramPollInterval(0.999),
	]);
	const candidate = count([
		telegramPollInterval(0),
		telegramPollInterval(0.5),
		telegramPollInterval(0.999),
		RECEIVER_FALLBACK_MS,
		RECEIVER_FALLBACK_MS,
		RECEIVER_FALLBACK_MS,
	]);
	expect(baseline).toEqual({ checks: 90, locks: 30 });
	expect(pollOnly).toEqual({ checks: 47, locks: 20 });
	expect(candidate).toEqual({ checks: 65, locks: 22 });
});

test('an empty room batch never schedules an overflowing timer', () => {
	expect(nextLocalRoomWakeAt()).toBeUndefined();
	expect(nextTelegramRoomWakeAt()).toBeUndefined();
});
