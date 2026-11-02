import { BrowserWindow, dialog, ipcMain } from 'electron';
import { resolve } from 'node:path';

import type { Team } from './team.ts';

import { galleryAvatar, installGalleryAvatar } from '../gallery-avatar.ts';
import { providerSetupCatalog } from '../provider-setup.ts';
import { removeAgent } from '../remove.ts';
import { stopForRest } from '../rest.ts';
import { probeRuntimePrerequisites } from '../runtime-prerequisite-probe.ts';
import { slugFor } from '../store.ts';
import { readMacros, saveMacros } from '../team-macros.ts';
import { profileFor, saveProfile } from '../team-maintenance.ts';
import { readTeamSettings, saveTeamSettings, type TeamSettings } from '../team-settings.ts';
import { readTeammateGallery } from '../teammate-gallery.ts';
import { cliStatuses } from './cli-status.ts';
import { checkLaunch, installedProviders } from './launch-check.ts';
import { stopRestSession } from './rest-stop.ts';
import { stopIfConfirmed } from './stop-evidence.ts';
import { usageFor } from './usage.ts';

export function maintenanceIpc(
	team: Team,
	trusted: (event: Electron.IpcMainInvokeEvent) => void,
	settingsChanged?: (settings: TeamSettings) => void,
): void {
	ipcMain.handle('team:provider-setup', (event) => {
		trusted(event);
		return providerSetupCatalog;
	});
	let runtimeProbe: ReturnType<typeof probeRuntimePrerequisites> | undefined;
	ipcMain.handle('team:runtime-prerequisites', (event) => {
		trusted(event);
		runtimeProbe ??= probeRuntimePrerequisites().finally(() => {
			runtimeProbe = undefined;
		});
		return runtimeProbe;
	});
	ipcMain.handle('team:gallery', (event) => {
		trusted(event);
		return readTeammateGallery(resolve(import.meta.dirname, '../../gallery'));
	});
	let probing: ReturnType<typeof cliStatuses> | undefined;
	ipcMain.handle('team:cli-status', (event) => {
		trusted(event);
		probing ??= cliStatuses().finally(() => {
			probing = undefined;
		});
		return probing;
	});
	ipcMain.handle('team:installed-providers', (event) => {
		trusted(event);
		return installedProviders();
	});
	for (const action of ['select', 'start'] as const) {
		ipcMain.handle(`team:${action}`, async (event, name: unknown) => {
			trusted(event);
			if (typeof name !== 'string') throw new Error('Invalid agent.');
			const slug = slugFor(name);
			if (action === 'start') await checkLaunch(slug);
			await team[action](slug);
		});
	}
	// Stop re-checks the session itself: the renderer's snapshot can be up to 2 s old.
	ipcMain.handle('team:stop', async (event, name: unknown, confirmed: unknown) => {
		trusted(event);
		if (typeof name !== 'string') throw new Error('Invalid agent.');
		return stopIfConfirmed(team, slugFor(name), confirmed === true);
	});
	ipcMain.handle('team:stop-rest', async (event, name: unknown, confirmation: unknown) => {
		trusted(event);
		if (typeof name !== 'string' || typeof confirmation !== 'string')
			throw new Error('Invalid rest confirmation.');
		const slug = slugFor(name);
		const session = team.sessions.get(slug);
		if (session?.agent.status !== 'running')
			throw new Error(`${slug}: session is not running in this Team Window.`);
		await stopForRest(
			slug,
			confirmation,
			(nonce) => stopRestSession(team, slug, nonce),
			session.agent.provider,
		);
		await team.publish();
	});
	ipcMain.handle('team:choose-folder', async (event) => {
		trusted(event);
		const window = BrowserWindow.fromWebContents(event.sender);
		if (!window) throw new Error('Team window is unavailable.');
		const result = await dialog.showOpenDialog(window, {
			title: 'Choose a working folder',
			properties: ['openDirectory'],
		});
		return result.canceled ? null : (result.filePaths[0] ?? null);
	});
	ipcMain.handle('team:hibernate', async (event, slug: unknown, active: unknown) => {
		trusted(event);
		if (typeof slug !== 'string' || typeof active !== 'boolean')
			throw new Error('Invalid hibernation control.');
		await team.hibernate(slug, active);
	});
	ipcMain.handle('team:settings', (event) => {
		trusted(event);
		return readTeamSettings();
	});
	ipcMain.handle('team:save-settings', async (event, value: unknown) => {
		trusted(event);
		const settings = await saveTeamSettings(value);
		settingsChanged?.(settings);
		return settings;
	});
	ipcMain.handle('team:macros', (event) => {
		trusted(event);
		return readMacros();
	});
	ipcMain.handle('team:save-macros', (event, value: unknown) => {
		trusted(event);
		return saveMacros(value);
	});
	let readingUsage = false;
	ipcMain.handle('team:usage', async (event, slug: unknown) => {
		trusted(event);
		if (typeof slug !== 'string') throw new Error('Invalid teammate.');
		if (readingUsage) throw new Error('A usage read is already in progress.');
		readingUsage = true;
		try {
			return await usageFor(slug);
		} finally {
			readingUsage = false;
		}
	});
	ipcMain.handle('team:profile', (event, slug: unknown) => {
		trusted(event);
		if (typeof slug !== 'string') throw new Error('Invalid teammate.');
		return profileFor(slug);
	});
	ipcMain.handle('team:save-profile', async (event, profile: unknown, existing: unknown) => {
		trusted(event);
		if (existing !== null && typeof existing !== 'string') throw new Error('Invalid teammate.');
		// No blanket refusal for a running teammate: saveProfile decides, and it refuses only the
		// one edit a live session conflicts with — changing its session ID. Everything else applies
		// at the teammate's next launch, so there is nothing to stop first.
		const avatar = await galleryAvatar(
			resolve(import.meta.dirname, '../../gallery'),
			profile,
			existing,
		);
		let note: string | undefined;
		const slug = await saveProfile(profile, existing, (text) => {
			note = text;
		});
		if (existing === null) await installGalleryAvatar(slug, avatar);
		await team.publish();
		return { slug, ...(note === undefined ? {} : { note }) };
	});
	ipcMain.handle('team:remove-profile', async (event, name: unknown, archive: unknown) => {
		trusted(event);
		if (typeof name !== 'string' || typeof archive !== 'boolean')
			throw new Error('Invalid removal.');
		const slug = slugFor(name);
		if (team.sessions.get(slug)?.agent.status === 'running')
			throw new Error('Stop the session first.');
		await removeAgent(slug, archive);
		team.sessions.delete(slug);
		if (team.selected === slug) team.selected = '';
		await team.publish();
	});
}
