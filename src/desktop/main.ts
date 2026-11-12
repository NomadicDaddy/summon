import { app, ipcMain, shell } from 'electron';
import { spawn } from 'node-pty';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { TeamEvent } from './types.ts';

import { communicationStatus } from '../communication-state.ts';
import { requireExecutable } from '../executable.ts';
import { sendHuman } from '../local-room-access.ts';
import { localBeforePage, localUnreadStats } from '../local-room-read-place.ts';
import { localPage, localTail } from '../local-room.ts';
import { dismissResponseEpisode } from '../response-watchdog-store.ts';
import { answerRoom } from '../room-question-access.ts';
import { appendRuntimeFault } from '../runtime-faults.ts';
import { slugFor } from '../store.ts';
import { initialMentionCursor } from '../team-mentions.ts';
import { readTeamSettings, type TeamSettings } from '../team-settings.ts';
import { readTeamStartup, recordTeamStartup, teamWindowRuntime } from '../team-startup.ts';
import { assertNonElevated } from '../windows-integrity.ts';
import { boardIpc } from './board-ipc.ts';
import { diaryIpc } from './diary-ipc.ts';
import { headDownIpc } from './head-down-ipc.ts';
import { maintenanceIpc } from './maintenance-ipc.ts';
import { createMentionScanRecorder } from './mention-scan-metrics.ts';
import { notepadIpc } from './notepad-ipc.ts';
import { DEFAULT_HOLD_POLICY } from './notification-pause.ts';
import { registerOperatorIpc } from './operator-ipc.ts';
import { trackOperatorView } from './operator-view.ts';
import { OperatorTerminal } from './operator.ts';
import { reposIpc } from './repos-ipc.ts';
import { persistImage, roomImageIpc } from './room-images.ts';
import { roomLinkIpc } from './room-link-ipc.ts';
import { runtimeFaultDelivery } from './runtime-fault-delivery.ts';
import { runtimeFaultIpc } from './runtime-fault-ipc.ts';
import { scheduleViewIpc } from './schedule-view-ipc.ts';
import { detectShells } from './shells.ts';
import { prepareTeamWindowStorage } from './startup-root.ts';
import { defaultStopRoot } from './stop-root.ts';
import { createTeamTimers } from './team-timers.ts';
import { Team } from './team.ts';
import { watchWindowHealth } from './window-health.ts';
import { createWindowShutdown } from './window-shutdown.ts';
import { createTeamWindow } from './window.ts';

if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1';
const [bun, cli, receipt] = await prepareTeamWindowStorage(process.argv.slice(2));
await mkdir(teamWindowRuntime(), { recursive: true, mode: 0o700 });
app.setPath('userData', teamWindowRuntime());
app.setName('summon');
if (!app.requestSingleInstanceLock()) {
	if (receipt) await writeFile(receipt, '{}');
	app.quit();
} else {
	void app
		.whenReady()
		.then(async () => {
			await assertNonElevated();
			let ready = false;
			let quitting = false;
			const events: TeamEvent[] = [];
			const delivery = runtimeFaultDelivery(
				() => team.startedAt,
				(event) => {
					if (event.type === 'snapshot') viewing.refresh();
					if (ready && !window.isDestroyed())
						window.webContents.send('team:event', event);
					else if (events.length < 1000) events.push(event);
				},
			);
			const team = new Team(requireExecutable(bun), cli, delivery.send, spawn);
			const mentionMetrics = createMentionScanRecorder(
				teamWindowRuntime('mention-scan-timings.json'),
				(error) => team.error(error),
			);
			// Each launch's root identity, so an unverified Stop can tell its root from a reused PID.
			team.stopRoot = defaultStopRoot;
			const mentionCursor = await initialMentionCursor();
			const previousTeamStart = await readTeamStartup();
			await recordTeamStartup(team.startedAt);
			const timers = createTeamTimers({
				team,
				send: (event) => window.webContents.send('team:event', event),
				canSend: () => ready && !window.isDestroyed(),
				halted: () => quitting,
				initialCursor: mentionCursor,
				previousTeamStart,
				onMentionDiagnostic: mentionMetrics.record,
			});
			timers.start();
			const focus = async (): Promise<void> => {
				if (quitting) return;
				if (window.isMinimized()) window.restore();
				window.show();
				window.focus();
				await team.publish();
			};
			app.on('second-instance', () => {
				if (ready) void focus().catch((error: unknown) => team.error(error));
			});
			const window = createTeamWindow((error) => team.error(error));
			// The automatic hold follows the team settings (Phillip #7266); a save refreshes it.
			let holdPolicy = DEFAULT_HOLD_POLICY;
			const applyHoldPolicy = (settings: TeamSettings): void => {
				holdPolicy = { autoHold: settings.autoHold, holdMs: settings.holdSeconds * 1000 };
			};
			applyHoldPolicy(await readTeamSettings());
			const viewing = trackOperatorView(
				window,
				() => team.selected,
				(name) => team.sessions.get(name)?.agent.status === 'running',
				(error) => team.error(error),
				() => holdPolicy,
			);
			team.notificationPause = viewing.view;
			const trusted = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): void => {
				if (
					event.sender !== window.webContents ||
					event.senderFrame !== window.webContents.mainFrame
				)
					throw new Error('Unknown team window.');
			};
			const shells = await detectShells();
			ipcMain.handle(
				'team:dismiss-response',
				async (event, slug: unknown, nonce: unknown, id: unknown) => {
					trusted(event);
					if (
						typeof slug !== 'string' ||
						typeof nonce !== 'string' ||
						typeof id !== 'string'
					)
						throw new Error('Invalid response episode.');
					await dismissResponseEpisode(slug, nonce, id);
					await team.publish();
				},
			);
			ipcMain.handle('team:pause-notifications', async (event, paused: unknown) => {
				trusted(event);
				if (typeof paused !== 'boolean') throw new Error('Invalid notification pause.');
				await viewing.set(paused);
				await team.publish();
			});
			maintenanceIpc(team, trusted, (settings) => {
				applyHoldPolicy(settings);
				viewing.refresh();
			});
			const lastPage = runtimeFaultIpc(trusted, delivery);
			boardIpc(trusted);
			diaryIpc(trusted);
			headDownIpc(trusted);
			notepadIpc(trusted);
			reposIpc(trusted, () => team.snapshot());
			scheduleViewIpc(trusted, () => team.snapshot());
			roomImageIpc(trusted);
			roomLinkIpc(trusted);
			ipcMain.handle('team:open-repository', (event) => {
				trusted(event);
				return shell.openExternal('https://github.com/NomadicDaddy/summon');
			});
			const operator = new OperatorTerminal(
				shells,
				process.cwd(),
				(event) => {
					if (!window.isDestroyed()) window.webContents.send('operator:event', event);
				},
				spawn,
			);
			registerOperatorIpc(operator, shells, trusted);
			ipcMain.handle('team:ready', async (event) => {
				trusted(event);
				ready = true;
				for (const message of events.splice(0))
					window.webContents.send('team:event', message);
				await focus().catch((error: unknown) => team.error(error));
				return team.snapshot();
			});
			ipcMain.handle('team:room-tail', async (event) => {
				trusted(event);
				return localTail(300);
			});
			ipcMain.handle('team:room-before', async (event, before: unknown) => {
				trusted(event);
				if (typeof before !== 'number') throw new Error('Invalid Room history position.');
				return localBeforePage(before);
			});
			ipcMain.handle('team:room-unread', async (event, after: unknown) => {
				trusted(event);
				if (typeof after !== 'number') throw new Error('Invalid Room read marker.');
				return localUnreadStats(after);
			});
			ipcMain.handle(
				'team:room-answer',
				async (event, id: unknown, choice: unknown, text: unknown) => {
					trusted(event);
					if (
						typeof id !== 'number' ||
						(choice !== null && typeof choice !== 'number') ||
						(text !== undefined && typeof text !== 'string')
					)
						throw new Error('Invalid question answer.');
					return answerRoom(id, choice, text);
				},
			);
			ipcMain.handle('team:room-read', async (event, after: unknown) => {
				trusted(event);
				if (typeof after !== 'number') throw new Error('Invalid room cursor.');
				const communication = await communicationStatus();
				return { ...(await localPage(after)), communication, paused: communication.paused };
			});
			ipcMain.handle(
				'team:room-send',
				async (event, text: unknown, reply: unknown, image: unknown) => {
					trusted(event);
					if (
						typeof text !== 'string' ||
						!(
							reply === null ||
							(typeof reply === 'number' && Number.isSafeInteger(reply))
						)
					)
						throw new Error('Invalid room message.');
					return sendHuman(text, reply, await persistImage(image));
				},
			);
			ipcMain.on('team:input', (event, name: unknown, data: unknown, humanInput: unknown) => {
				trusted(event);
				if (
					typeof name === 'string' &&
					typeof data === 'string' &&
					typeof humanInput === 'boolean'
				) {
					const slug = slugFor(name);
					// The only renewal source: typing elsewhere in the window is not talking to
					// this teammate (Phillip #13984); see notification-pause.ts.
					viewing.terminalInput(slug, humanInput);
					void team
						.input(slug, data, humanInput)
						.catch((error: unknown) => team.error(error));
				}
			});
			ipcMain.on('team:resize', (event, name: unknown, cols: unknown, rows: unknown) => {
				trusted(event);
				if (
					typeof name === 'string' &&
					typeof cols === 'number' &&
					typeof rows === 'number'
				)
					team.resize(slugFor(name), cols, rows);
			});
			const shutdown = createWindowShutdown({
				stopPolling: async () => {
					await timers.stop();
					await mentionMetrics.flush();
				},
				startPolling: timers.start,
				setClosing: (value) => {
					quitting = value;
				},
				stopSessions: () => [team.shutdown(), operator.shutdown()],
				recover: () => {
					team.closing = false;
					operator.cancelShutdown();
				},
				quit: () => {
					void delivery.flush().then(() => app.quit());
				},
				error: (error) => team.error(error),
			});
			window.on('close', shutdown.close);
			app.on('before-quit', shutdown.close);
			watchWindowHealth(
				window.webContents,
				delivery.report,
				() => void shutdown.request(),
				lastPage,
			);
			await window.loadFile(fileURLToPath(new URL('./index.html', import.meta.url)));
			window.show();
			if (receipt) await writeFile(receipt, '{}');
		})
		.catch(async (error: unknown) => {
			await appendRuntimeFault(
				{
					level: 'error',
					source: 'window.startup',
					text:
						error instanceof Error
							? error.message.slice(0, 8192)
							: 'Unclassified startup failure.',
				},
				new Date().toISOString(),
			).catch(() =>
				console.error(
					'Runtime error log unavailable; saving the startup diagnostic was not confirmed.',
				),
			);
			console.error(error);
			app.exit(1);
		});
}
