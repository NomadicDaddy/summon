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
 * The Team Window's side of operator Away. The startup read, every toggle and every input clear
 * run in one queue, in the order they arrived, so each input clears exactly the Aways requested
 * before it and nothing settles out of order (Roger #48243). IPC keeps a renderer's messages in
 * order, so a keystroke sent before a toggle arrives before it.
 */
export function operatorAwayIpc(
	trusted: Trusted,
	publish: () => Promise<void>,
	report: (error: unknown) => void,
): OperatorAwayControl {
	let current: OperatorAwayView = { state: 'here' };
	let queue: Promise<unknown> = Promise.resolve();
	let queued = 0;
	let lastKind: 'init' | 'input' | 'toggle' = 'init';
	let lastWaiting = false;
	let sequence = 0;
	const settle = async (result: AwayTransition): Promise<AwayTransition> => {
		current = result.view;
		if (result.changed) await publish();
		if (result.roomError)
			report(new Error(`Away changed, but its Room line wasn't posted: ${result.roomError}`));
		return result;
	};
	const serial = <T>(kind: typeof lastKind, work: () => Promise<T>): Promise<T> => {
		const mine = ++sequence;
		queued++;
		lastKind = kind;
		lastWaiting = true;
		const run = async (): Promise<T> => {
			if (sequence === mine) lastWaiting = false;
			try {
				return await work();
			} finally {
				queued--;
			}
		};
		const next = queue.then(run, run);
		queue = next.catch(() => undefined);
		return next;
	};
	void serial('init', async () => {
		current = await readOperatorAway();
		await publish();
	}).catch(report);

	ipcMain.handle('team:operator-away-toggle', async (event, cause: unknown) => {
		trusted(event);
		if (cause !== 'button' && cause !== 'shortcut') throw new Error('Invalid Away control.');
		return serial('toggle', async () => {
			const stored = await readOperatorAway();
			return settle(await setOperatorAway(stored.state !== 'away', cause));
		});
	});
	const input = (cause: InputCause): void => {
		// Idle and Here: nothing to clear, and no file read per keystroke.
		if (queued === 0 && current.state !== 'away') return;
		// A clear already waiting at the end of the queue covers this keystroke too.
		if (lastKind === 'input' && lastWaiting) return;
		void serial('input', async () => settle(await setOperatorAway(false, cause))).catch(report);
	};
	ipcMain.on('team:operator-input', (event, cause: unknown) => {
		trusted(event);
		if (typeof cause !== 'string' || !RENDERER_INPUT.includes(cause as InputCause)) return;
		input(cause as InputCause);
	});
	return { view: () => current, input };
}
