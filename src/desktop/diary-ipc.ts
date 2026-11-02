import { ipcMain } from 'electron';

import { readDiary } from '../diary.ts';

export function diaryIpc(trusted: (event: Electron.IpcMainInvokeEvent) => void): void {
	ipcMain.handle('team:diary-read', (event, before: unknown, search: unknown) => {
		trusted(event);
		return readDiary(before, search);
	});
}
