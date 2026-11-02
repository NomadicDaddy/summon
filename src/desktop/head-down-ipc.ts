import { ipcMain } from 'electron';

import { delegateHeadDown } from '../head-down-access.ts';
import { decideHeadDown, endHeadDown } from '../head-down.ts';

export function headDownIpc(trusted: (event: Electron.IpcMainInvokeEvent) => void): void {
	ipcMain.handle(
		'team:head-down-decision',
		async (event, name: unknown, id: unknown, approve: unknown) => {
			trusted(event);
			if (typeof name !== 'string' || typeof id !== 'string' || typeof approve !== 'boolean')
				throw new Error('Invalid head-down decision.');
			await decideHeadDown(name, id, approve);
		},
	);
	ipcMain.handle(
		'team:head-down-end',
		async (event, name: unknown, id: unknown, reason: unknown) => {
			trusted(event);
			if (typeof name !== 'string' || typeof id !== 'string' || typeof reason !== 'string')
				throw new Error('Invalid head-down end.');
			await endHeadDown(name, id, reason);
		},
	);
	ipcMain.handle('team:head-down-delegate', async (event, name: unknown, enabled: unknown) => {
		trusted(event);
		if (typeof name !== 'string' || typeof enabled !== 'boolean')
			throw new Error('Invalid delegation.');
		await delegateHeadDown(name, enabled);
	});
}
