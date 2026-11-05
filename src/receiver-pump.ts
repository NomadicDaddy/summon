import { RECEIVER_FALLBACK_MS } from './receiver-cadence.ts';

export interface ReceiverClock {
	now: () => number;
	setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
	clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
	setInterval: (callback: () => void, delay: number) => ReturnType<typeof setInterval>;
	clearInterval: (timer: ReturnType<typeof setInterval>) => void;
}

const systemClock: ReceiverClock = {
	now: () => Date.now(),
	setTimeout,
	clearTimeout,
	setInterval,
	clearInterval,
};

/** Coalesce bursts without losing an event that arrives during a cycle. */
export function createReceiverPump(
	run: () => Promise<void>,
	nextDeadline: () => Promise<number | undefined>,
	onError: (error: unknown) => Promise<void>,
	clock: ReceiverClock = systemClock,
): { schedule: () => void; stop: () => Promise<void> } {
	let stopped = false;
	let busy: Promise<void> | undefined;
	let queued = false;
	let alarm: ReturnType<typeof setTimeout> | undefined;
	const report = async (error: unknown): Promise<void> => {
		try {
			await onError(error);
		} catch {
			console.error('Receiver failure could not be retained; inspect own delivery storage.');
		}
	};
	const schedule = (): void => {
		if (stopped) return;
		if (busy) {
			queued = true;
			return;
		}
		if (alarm) clock.clearTimeout(alarm);
		alarm = undefined;
		busy = Promise.resolve()
			.then(run)
			.catch(report)
			.then(async () => {
				const next = await nextDeadline();
				if (!stopped && next !== undefined && next > clock.now())
					alarm = clock.setTimeout(schedule, Math.max(1, next - clock.now()));
			})
			.catch(report)
			.finally(() => {
				busy = undefined;
				if (queued && !stopped) {
					queued = false;
					schedule();
				}
			});
	};
	const fallback = clock.setInterval(schedule, RECEIVER_FALLBACK_MS);
	return {
		schedule,
		stop: async () => {
			stopped = true;
			clock.clearInterval(fallback);
			if (alarm) clock.clearTimeout(alarm);
			await busy;
		},
	};
}
