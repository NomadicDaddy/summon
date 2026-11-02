import { ipcMain, shell } from 'electron';
import { pathToFileURL } from 'node:url';

import type { TeamSnapshot } from './types.ts';

import { RepositoryService } from '../repository-service.ts';

export function reposIpc(
	trusted: (event: Electron.IpcMainInvokeEvent) => void,
	snapshot: () => Promise<TeamSnapshot>,
): void {
	const service = new RepositoryService();
	let listing: ReturnType<RepositoryService['list']> | undefined;
	ipcMain.handle('team:repos-list', (event) => {
		trusted(event);
		listing ??= snapshot()
			.then((value) => service.list(value.agents))
			.finally(() => {
				listing = undefined;
			});
		return listing;
	});
	ipcMain.handle('team:repos-detail', (event, id: unknown) => {
		trusted(event);
		return service.detail(id);
	});
	ipcMain.handle('team:repos-diff', (event, id: unknown, value: unknown) => {
		trusted(event);
		return service.diff(id, value);
	});
	ipcMain.handle('team:repos-open', async (event, id: unknown, target: unknown) => {
		trusted(event);
		const path = service.path(id);
		if (target === 'code')
			await shell.openExternal(`vscode://file${pathToFileURL(path).pathname}`);
		else if (target === 'folder') {
			const error = await shell.openPath(path);
			if (error) throw new Error(error);
		} else throw new Error('Unknown repository destination.');
	});
}
