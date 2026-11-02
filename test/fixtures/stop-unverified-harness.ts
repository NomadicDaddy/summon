import { expect } from 'bun:test';

import type { StopRootState } from '../../src/desktop/stop-root.ts';
import type { TeamEvent } from '../../src/desktop/types.ts';

import { ProcessTreeStopError } from '../../src/desktop/pty-process.ts';
import { Team, type TerminalProcess } from '../../src/desktop/team.ts';
import { readSessionHistory } from '../../src/session-history.ts';

/** Taskkill fails once per call without ending the fake terminal; the root reads as `root`. */
export function failingHarness(
	root: StopRootState,
	failure: (pid: number) => Error = taskkillFailure,
) {
	const events: TeamEvent[] = [];
	const exits = new Map<number, (event: { exitCode: number }) => void>();
	const writes: string[] = [];
	const terminated: number[] = [];
	const rootReads: number[] = [];
	let nextPid = 100;
	const team = new Team(
		'bun',
		'cli.ts',
		(event) => {
			events.push(event);
		},
		() => {
			const pid = nextPid++;
			const pty: TerminalProcess = {
				pid,
				onData: () => ({ dispose: () => {} }),
				onExit: (listener) => {
					exits.set(pid, listener);
					return { dispose: () => {} };
				},
				write: (data) => {
					writes.push(String(data));
				},
				resize: () => {},
				kill: () => exits.get(pid)?.({ exitCode: 0 }),
			};
			return pty;
		},
		async (pid) => {
			terminated.push(pid);
			await Promise.resolve();
			throw failure(pid);
		},
	);
	team.stopRoot = {
		capture: (pid) => Promise.resolve(pid * 10),
		state: async (pid, startedAt) => {
			rootReads.push(pid);
			// The launch capture is handed to the reader unchanged.
			expect(startedAt).toBe(pid * 10);
			await Promise.resolve();
			return root;
		},
	};
	const exit = (slug: string, exitCode = 1): void => {
		const pid = team.sessions.get(slug)?.pty.pid;
		if (pid === undefined) throw new Error(`Missing ${slug}.`);
		exits.get(pid)?.({ exitCode });
	};
	return { team, events, writes, terminated, rootReads, exit };
}

function taskkillFailure(pid: number): ProcessTreeStopError {
	return new ProcessTreeStopError(
		pid,
		128,
		null,
		`SUCCESS: The process with PID ${pid} (child process of PID 1) has been terminated.\nERROR: The process with PID 7372 (child process of PID 29284) could not be terminated.\nReason: The operation attempted is not supported.`,
	);
}

/** One member's session history, oldest first, as `state:reason`. */
export async function states(member: string): Promise<string[]> {
	const history = await readSessionHistory({ limit: 20, member });
	return [...history.entries].reverse().map((entry) => `${entry.state}:${entry.reason}`);
}
