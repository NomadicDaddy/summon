import { ipcMain } from 'electron';

import { readBoard } from '../board.ts';
import { moveBoard, ownBoard } from './board-move.ts';

export function boardIpc(trusted: (event: Electron.IpcMainInvokeEvent) => void): void {
	ipcMain.handle('team:board-read', (event) => {
		trusted(event);
		return readBoard();
	});
	ipcMain.handle('team:board-move', (event, id: unknown, revision: unknown, move: unknown) => {
		trusted(event);
		return moveBoard(id, revision, move);
	});
	ipcMain.handle('team:board-owner', (event, id: unknown, revision: unknown, owner: unknown) => {
		trusted(event);
		return ownBoard(id, revision, owner);
	});
}
