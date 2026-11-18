import { stat } from 'node:fs/promises';

import type { State } from './schedule-store.ts';

export const SCHEDULE_WARNING_BYTES = 32 * 1024 * 1024;

/**
 * Best effort, and never a halt: past each 32 MiB step, ask the window to record one runtime
 * warning, then mark the step in the saved state. It reads the file's size, not the size of one
 * save, and the Team Window runs it on every dispatch tick, paused or not, so growth from any
 * writer (finish, create, update and owner removal included) is caught at the next tick. Agent
 * CLI writers cannot write the operator-only fault journal, so they never try. The journal and the
 * state file are separate writes: a crash between them can repeat a warning, and a journal that
 * keeps failing means none arrives. Nothing here can fail a writer, and nothing is pruned.
 */
export async function warnScheduleSize(
	state: State,
	path: string,
	warn: (text: string) => Promise<void>,
	save: (state: State) => Promise<number>,
): Promise<void> {
	try {
		const bytes = (await stat(path)).size;
		const step = Math.floor(bytes / SCHEDULE_WARNING_BYTES);
		if (step < 1 || step <= (state.warnedStep ?? 0)) return;
		await warn(
			`Schedule state is ${bytes} bytes, past ${step * 32} MiB. Dispatch continues and no run is pruned; what to do next is the operator's decision.`,
		);
		state.warnedStep = step;
		await save(state);
	} catch {
		// Retried at a later dispatch: warnedStep only advances after a successful warning.
	}
}
