import { ipcMain } from 'electron';

import { runtimeFaultInput } from '../runtime-fault-model.ts';
import { lastPageText, type PageState, pageStateFrom } from './page-state.ts';
import { runtimeFaultDelivery } from './runtime-fault-delivery.ts';

/**
 * The renderer's fault reports, and its last-known page layout (page-state.ts), which renderer
 * failure lines quote because a hung page cannot be asked.
 * @returns The last page state in words, for the fault journal.
 */
export function runtimeFaultIpc(
	trusted: (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => void,
	delivery: ReturnType<typeof runtimeFaultDelivery>,
	now: () => number = Date.now,
): () => string {
	ipcMain.handle('team:fault-report', async (event, input: unknown) => {
		trusted(event);
		await delivery.report(runtimeFaultInput.parse(input));
	});
	let last: { at: number; state: PageState } | null = null;
	ipcMain.on('team:page-state', (event, value: unknown) => {
		try {
			trusted(event);
		} catch {
			return;
		}
		const state = pageStateFrom(value);
		if (state) last = { at: now(), state };
	});
	return () => lastPageText(last, now());
}
