import { ipcMain } from 'electron';

import { readNotepad, saveNotepad } from '../notepad.ts';

export function notepadIpc(trusted: (event: Electron.IpcMainInvokeEvent) => void): void {
	ipcMain.handle('team:notepad-read', (event) => {
		trusted(event);
		return readNotepad();
	});
	ipcMain.handle('team:notepad-save', (event, text: unknown, revision: unknown) => {
		trusted(event);
		return saveNotepad(text, revision);
	});
}
