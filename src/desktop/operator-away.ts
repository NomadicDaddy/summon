import { ipcMain } from 'electron';

import type { AwayTransition, InputCause, OperatorAwayView } from '../operator-away.ts';

import { readOperatorAway, setOperatorAway } from '../operator-away.ts';

type Trusted = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => void;

/** Input surfaces the renderer reports; the main process reports terminals, sends and answers itself. */
const RENDERER_INPUT: readonly InputCause[] = [
	'operator-shell',
	'room-draft',
	'notepad',
	'search',
	'maintenance',
];

export interface OperatorAwayControl {
	/** The last confirmed state, for TeamSnapshot. */
	view: () => OperatorAwayView;
	/** Deliberate operator input on a surface; clears Away, and is a no-op while Here. */
	input: (cause: InputCause) => void;
}

/**
 * The Team Window's side of operator Away. Toggles run one at a time against the stored state, so
 * a double press can't race itself; input only ever clears, and only when Away is shown.
 */
export function operatorAwayIpc(
	trusted: Trusted,
	publish: () => Promise<void>,
	report: (error: unknown) => void,
): OperatorAwayControl {
	let current: OperatorAwayView = { state: 'here' };
	let queue: Promise<unknown> = Promise.resolve();
	const settle = async (result: AwayTransition): Promise<AwayTransition> => {
		current = result.view;
		if (result.changed) await publish();
		if (result.roomError)
			report(new Error(`Away changed, but its Room line wasn't posted: ${result.roomError}`));
		return result;
	};
	const serial = <T>(work: () => Promise<T>): Promise<T> => {
		const next = queue.then(work, work);
		queue = next.catch(() => undefined);
		return next;
	};
	void readOperatorAway()
		.then(async (view) => {
			current = view;
			await publish();
		})
		.catch(report);

	ipcMain.handle('team:operator-away-toggle', async (event, cause: unknown) => {
		trusted(event);
		if (cause !== 'button' && cause !== 'shortcut') throw new Error('Invalid Away control.');
		return serial(async () => {
			const stored = await readOperatorAway();
			return settle(await setOperatorAway(stored.state !== 'away', cause));
		});
	});
	// One clear in flight at a time: a burst of keystrokes while Away asks once, not per key. Every
	// input is stamped here, on arrival, with the same clock that stamped the Away it may clear; IPC
	// keeps a renderer's messages in order, so a keystroke sent before a toggle arrives before it.
	let clearing = false;
	const input = (cause: InputCause): void => {
		if (current.state !== 'away' || clearing) return;
		clearing = true;
		const at = Date.now();
		void serial(async () => settle(await setOperatorAway(false, cause, at)))
			.catch(report)
			.finally(() => {
				clearing = false;
			});
	};
	ipcMain.on('team:operator-input', (event, cause: unknown) => {
		trusted(event);
		if (typeof cause !== 'string' || !RENDERER_INPUT.includes(cause as InputCause)) return;
		input(cause as InputCause);
	});
	return { view: () => current, input };
}
