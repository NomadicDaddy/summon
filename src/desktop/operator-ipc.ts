import { clipboard, ipcMain } from 'electron';

import type { OperatorTerminal } from './operator.ts';

export function registerOperatorIpc(
	operator: OperatorTerminal,
	shells: { id: string; label: string }[],
	trusted: (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => void,
): void {
	ipcMain.handle('operator:copy', async (event, text: unknown) => {
		trusted(event);
		if (typeof text !== 'string' || text.length > 1_000_000)
			throw new Error('Select up to one million characters to copy.');
		await clipboard.writeText(text);
	});
	ipcMain.handle('operator:shells', (event) => {
		trusted(event);
		return shells.map(({ id, label }) => ({ id, label }));
	});
	ipcMain.handle('operator:start', (event, id: unknown, cols: unknown, rows: unknown) => {
		trusted(event);
		if (typeof id !== 'string' || typeof cols !== 'number' || typeof rows !== 'number')
			throw new Error('Invalid terminal request.');
		operator.start(id, cols, rows);
	});
	ipcMain.handle('operator:stop', async (event) => {
		trusted(event);
		await operator.stop();
	});
	ipcMain.on('operator:input', (event, data: unknown) => {
		trusted(event);
		if (typeof data === 'string') operator.input(data);
	});
	ipcMain.on('operator:resize', (event, cols: unknown, rows: unknown) => {
		trusted(event);
		if (typeof cols === 'number' && typeof rows === 'number') operator.resize(cols, rows);
	});
}
