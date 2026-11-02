/** Wall time labels the record; elapsed time within a process comes from a monotonic clock. */
export function createResponseClock() {
	let anchor: { wall: number; monotonic: number; logical: number } | undefined;
	return (savedAt: number | undefined, wall = Date.now(), monotonic = performance.now()) => {
		const elapsed = anchor ? monotonic - anchor.monotonic : 0;
		const reset = anchor
			? elapsed < 0 || Math.abs(wall - anchor.wall - elapsed) > 60000
			: savedAt !== undefined && (wall < savedAt || wall - savedAt > 86400000);
		const now = anchor && !reset ? anchor.logical + elapsed : wall;
		anchor = { wall, monotonic, logical: now };
		return { now, reset };
	};
}
