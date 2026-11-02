import type { TeamAgent } from './types.ts';

import { setSweptLabel } from './letter-sweep.ts';
import { nativeCompacting } from './native-compaction.ts';
import { observationUnavailable } from './observation-unavailable.ts';

/**
 * How long a launch phase may walk. A launch that is going somewhere is through its phases in a
 * couple of minutes; one still in the same phase after this is stuck, and letters that keep moving
 * would say progress where there is none. The word stays and holds still, and its tooltip already
 * says since when.
 */
export const LAUNCH_WALK_MS = 5 * 60_000;

/**
 * Whether a state label's letters light in turn: on Compacting (#8406), and on a launch phase
 * (#10212) while that phase is the label shown and has not outlasted a normal launch. Busy and
 * Needs you are states a teammate reports and can hold for hours, and the rest are settled, so
 * they stay still. `launchWord` is the row's wording for the active launch, if it has one.
 */
export function stateLabelMoves(
	agent: TeamAgent | undefined,
	label: string,
	launchWord: string | undefined,
	now = Date.now(),
): boolean {
	if (!agent || observationUnavailable(agent)) return false;
	if (nativeCompacting(agent)) return true;
	if (launchWord === undefined || label !== launchWord || !agent.launch) return false;
	const began = Date.parse(agent.launch.since);
	return Number.isFinite(began) && now - began < LAUNCH_WALK_MS;
}

type StopHandle = ReturnType<typeof setTimeout>;

/** The clock and writer a label's motion uses; tests pass their own. */
export interface LabelMotionDeps {
	cancel: (handle: StopHandle) => void;
	now: () => number;
	schedule: (stop: () => void, delay: number) => StopHandle;
	write: (element: HTMLElement, text: string, active: boolean) => void;
}

const windowDeps: LabelMotionDeps = {
	cancel: (handle) => clearTimeout(handle),
	now: () => Date.now(),
	schedule: (stop, delay) => setTimeout(stop, delay),
	write: setSweptLabel,
};

const pendingStops = new WeakMap<HTMLElement, StopHandle>();

/** Milliseconds until a walking launch phase reaches LAUNCH_WALK_MS; undefined when nothing is timed. */
function launchWalkLeft(agent: TeamAgent | undefined, moves: boolean, now: number) {
	if (!moves || !agent?.launch || nativeCompacting(agent)) return undefined;
	return Date.parse(agent.launch.since) + LAUNCH_WALK_MS - now;
}

/**
 * Write a state label with its motion, and stop a walking launch phase when it reaches
 * LAUNCH_WALK_MS even if nothing draws the roster again: the roster redraws only when its snapshot
 * changes, and a stuck launch changes nothing (roger #11278, morticia #11275). Each write replaces
 * the element's pending stop, so a redraw or a new phase never leaves an old one behind.
 */
export function writeLabelMotion(
	element: HTMLElement,
	agent: TeamAgent | undefined,
	label: string,
	launchWord: string | undefined,
	deps: LabelMotionDeps = windowDeps,
): void {
	const previous = pendingStops.get(element);
	if (previous !== undefined) deps.cancel(previous);
	pendingStops.delete(element);
	const now = deps.now();
	const moves = stateLabelMoves(agent, label, launchWord, now);
	deps.write(element, label, moves);
	const left = launchWalkLeft(agent, moves, now);
	if (left === undefined) return;
	const stop = (): void => {
		pendingStops.delete(element);
		deps.write(element, label, false);
	};
	pendingStops.set(element, deps.schedule(stop, left));
}
