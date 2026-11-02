import { processAlive } from '../process-owner.ts';
import { type ProcessSnapshot, sessionLaunchFor, snapshotFor } from '../session-presence.ts';

/**
 * What one read says about a session's root process after taskkill reported a failure. This is a
 * diagnostic for the operator, never proof that a process tree has settled: only the terminal's
 * own exit marks a session stopped. `gone` covers a PID now held by a newer process.
 */
export type StopRootState = 'alive' | 'gone' | 'unknown';

/** The launch a root identity is captured for: when it began, and the member and nonce it carries. */
export interface RootLaunch {
	since: number;
	slug: string;
	nonce: string;
}

/** The root identity reader, replaceable in tests so they never query the host. */
export interface StopRoot {
	/** The root's own creation time, or undefined when it cannot be tied to this launch. */
	capture: (pid: number, launch: RootLaunch) => Promise<number | undefined>;
	state: (pid: number, startedAt: number | undefined) => Promise<StopRootState>;
}

/**
 * How far two reads of one process's start may differ. Windows reports creation to the
 * millisecond, so it must match exactly; `ps` only places a start within its second.
 */
export const startPrecisionMs = (platform: NodeJS.Platform): number =>
	platform === 'win32' ? 0 : 1000;

/**
 * Reads the root once, just after spawn, and keeps the start time only when it is this exact
 * launch: the Window itself is in the same snapshot (positive control), and the process is the
 * Window's child running `__session <slug>` with this launch's `--launch-nonce`, started no earlier
 * than the launch. Any other process that reused the PID, such as the Window's own `bun --version`
 * runtime check, carries no matching nonce and records nothing. The command line is compared
 * inside session-presence and never kept.
 */
export async function captureRootStart(
	pid: number,
	launch: RootLaunch,
	snapshot: ProcessSnapshot = snapshotFor(process.platform),
	self = process.pid,
	precisionMs = startPrecisionMs(process.platform),
): Promise<number | undefined> {
	const facts = await snapshot([pid, self]).catch(() => undefined);
	const root = facts?.get(pid);
	if (!facts?.has(self) || root?.startedAt === undefined) return undefined;
	if (root.parentPid !== self || root.startedAt < launch.since - precisionMs) return undefined;
	return sessionLaunchFor(root, launch.slug, launch.nonce) ? root.startedAt : undefined;
}

/**
 * Judges the root as session-presence does: a snapshot can omit a live process, so absence counts
 * only when the operating system also says the PID does not exist. Alive needs the exact identity
 * captured at launch; without it the answer is unknown, never alive. The Window's own PID is the
 * positive control, and taskkill's text is never read, so localized output cannot change it.
 */
export async function stopRootState(
	pid: number,
	startedAt: number | undefined,
	snapshot: ProcessSnapshot = snapshotFor(process.platform),
	exists: (pid: number) => boolean = processAlive,
	self = process.pid,
	precisionMs = startPrecisionMs(process.platform),
): Promise<StopRootState> {
	const facts = await snapshot([pid, self]).catch(() => undefined);
	if (!facts?.has(self)) return 'unknown';
	const root = facts.get(pid);
	if (!root) return exists(pid) ? 'unknown' : 'gone';
	if (root.startedAt === undefined || startedAt === undefined) return 'unknown';
	// A PID held by a process that is not the captured root has been reused.
	return Math.abs(root.startedAt - startedAt) <= precisionMs ? 'alive' : 'gone';
}

export const defaultStopRoot: StopRoot = {
	capture: (pid, launch) => captureRootStart(pid, launch),
	state: (pid, startedAt) => stopRootState(pid, startedAt),
};
