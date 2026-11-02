import { ipcMain, shell } from 'electron';

import { externalRoomUrl } from './room-links.ts';

export function roomLinkIpc(trusted: (event: Electron.IpcMainInvokeEvent) => void): void {
	ipcMain.handle('team:open-room-url', async (event, value: unknown) => {
		trusted(event);
		await shell.openExternal(externalRoomUrl(value));
	});
}
