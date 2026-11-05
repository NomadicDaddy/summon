/** Candidate cadence; exact deadlines and file events run outside the fallback scan. */
export const RECEIVER_FALLBACK_MS = 10_000;
/** An exceptional not-sent retry checks for forward clock jumps without scanning while idle. */
export const RETRY_CLOCK_GUARD_MS = 2_000;
export const TELEGRAM_POLL_MIN_MS = 3_000;
export const TELEGRAM_POLL_JITTER_MS = 2_000;

export function telegramPollInterval(random = Math.random()): number {
	return TELEGRAM_POLL_MIN_MS + Math.floor(random * TELEGRAM_POLL_JITTER_MS);
}
