import { ipcMain } from 'electron';

import type { TeamSnapshot } from './types.ts';

import { scheduleView } from '../schedule-view.ts';
import { listSchedules } from '../schedules.ts';

/** Read only. The Team Window is the operator, so the store returns every owner's schedules. */
export function scheduleViewIpc(
	trusted: (event: Electron.IpcMainInvokeEvent) => void,
	snapshot: () => Promise<TeamSnapshot>,
): void {
	ipcMain.handle('team:schedule-view', async (event) => {
		trusted(event);
		const [state, team] = await Promise.all([listSchedules(), snapshot()]);
		return scheduleView(
			state,
			team.agents.map(({ slug, name }) => ({ slug, name })),
		);
	});
}
