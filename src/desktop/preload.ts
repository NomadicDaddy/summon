import { contextBridge, ipcRenderer } from 'electron';

import type { BoardSnapshot } from '../board-model.ts';
import type { DiaryPage } from '../diary.ts';
import type { LocalEvent } from '../local-room.ts';
import type { NotepadSnapshot } from '../notepad.ts';
import type { ProviderSetupCatalog } from '../provider-setup.ts';
import type { RepositoryDetail, RepositoryList } from '../repository-model.ts';
import type { RuntimePrerequisiteStatus } from '../runtime-prerequisites.ts';
import type { ScheduleView } from '../schedule-view.ts';
import type { Provider } from '../store.ts';
import type { TeamMacro } from '../team-macros.ts';
import type { TeamProfile } from '../team-maintenance.ts';
import type { TeamSettings } from '../team-settings.ts';
import type { GallerySnapshot } from '../teammate-templates.ts';
import type { CliStatus } from './cli-status.ts';
import type {
	OperatorEvent,
	RoomImage,
	RoomPage,
	ShellChoice,
	StopResult,
	TeamBridge,
	TeamEvent,
	TeamSnapshot,
} from './types.ts';
import type { UsageReport } from './usage.ts';

const bridge: TeamBridge = {
	faultReport: (input) => ipcRenderer.invoke('team:fault-report', input) as Promise<void>,
	pageState: (state) => {
		ipcRenderer.send('team:page-state', state);
	},
	providerSetup: () => ipcRenderer.invoke('team:provider-setup') as Promise<ProviderSetupCatalog>,
	gallery: () => ipcRenderer.invoke('team:gallery') as Promise<GallerySnapshot>,
	pauseNotifications: (paused) =>
		ipcRenderer.invoke('team:pause-notifications', paused) as Promise<void>,
	headDownDecision: (slug, id, approve) =>
		ipcRenderer.invoke('team:head-down-decision', slug, id, approve) as Promise<void>,
	headDownEnd: (slug, id, reason) =>
		ipcRenderer.invoke('team:head-down-end', slug, id, reason) as Promise<void>,
	headDownDelegate: (slug, enabled) =>
		ipcRenderer.invoke('team:head-down-delegate', slug, enabled) as Promise<void>,
	cliStatus: () => ipcRenderer.invoke('team:cli-status') as Promise<CliStatus[]>,
	runtimePrerequisites: () =>
		ipcRenderer.invoke('team:runtime-prerequisites') as Promise<RuntimePrerequisiteStatus[]>,
	installedProviders: () => ipcRenderer.invoke('team:installed-providers') as Promise<Provider[]>,
	openRoomUrl: (url) => ipcRenderer.invoke('team:open-room-url', url) as Promise<void>,
	chooseFolder: () => ipcRenderer.invoke('team:choose-folder') as Promise<string | null>,
	settings: () => ipcRenderer.invoke('team:settings') as Promise<TeamSettings>,
	saveSettings: (value) =>
		ipcRenderer.invoke('team:save-settings', value) as Promise<TeamSettings>,
	macros: () => ipcRenderer.invoke('team:macros') as Promise<TeamMacro[]>,
	saveMacros: (value) => ipcRenderer.invoke('team:save-macros', value) as Promise<TeamMacro[]>,
	openRepository: () => ipcRenderer.invoke('team:open-repository') as Promise<void>,
	usage: (slug) => ipcRenderer.invoke('team:usage', slug) as Promise<UsageReport>,
	profile: (slug) => ipcRenderer.invoke('team:profile', slug) as Promise<TeamProfile>,
	saveProfile: (profile, existing) =>
		ipcRenderer.invoke('team:save-profile', profile, existing) as Promise<{
			slug: string;
			note?: string;
		}>,
	removeProfile: (slug, archive) =>
		ipcRenderer.invoke('team:remove-profile', slug, archive) as Promise<void>,
	onImagePaste: (listener) => {
		ipcRenderer.on('team:image-paste', listener);
	},
	shells: () => ipcRenderer.invoke('operator:shells') as Promise<ShellChoice[]>,
	operatorStart: (id, cols, rows) =>
		ipcRenderer.invoke('operator:start', id, cols, rows) as Promise<void>,
	operatorStop: () => ipcRenderer.invoke('operator:stop') as Promise<void>,
	operatorCopy: (text) => ipcRenderer.invoke('operator:copy', text) as Promise<void>,
	operatorInput: (data) => ipcRenderer.send('operator:input', data),
	operatorResize: (cols, rows) => ipcRenderer.send('operator:resize', cols, rows),
	onOperatorEvent: (listener) => {
		ipcRenderer.on('operator:event', (_event, value: OperatorEvent) => listener(value));
	},
	roomRead: (after) => ipcRenderer.invoke('team:room-read', after) as Promise<RoomPage>,
	roomTail: () => ipcRenderer.invoke('team:room-tail') as Promise<number>,
	roomAnswer: (id, choice, text) =>
		ipcRenderer.invoke('team:room-answer', id, choice, text) as Promise<LocalEvent>,
	boardRead: () => ipcRenderer.invoke('team:board-read') as Promise<BoardSnapshot>,
	diaryRead: (before, search) =>
		ipcRenderer.invoke('team:diary-read', before, search) as Promise<DiaryPage>,
	notepadRead: () => ipcRenderer.invoke('team:notepad-read') as Promise<NotepadSnapshot>,
	notepadSave: (text, revision) =>
		ipcRenderer.invoke('team:notepad-save', text, revision) as Promise<NotepadSnapshot>,
	scheduleView: () => ipcRenderer.invoke('team:schedule-view') as Promise<ScheduleView>,
	reposList: () => ipcRenderer.invoke('team:repos-list') as Promise<RepositoryList>,
	reposDetail: (id) => ipcRenderer.invoke('team:repos-detail', id) as Promise<RepositoryDetail>,
	reposDiff: (id, value) => ipcRenderer.invoke('team:repos-diff', id, value) as Promise<string>,
	reposOpen: (id, target) => ipcRenderer.invoke('team:repos-open', id, target) as Promise<void>,
	boardMove: (id, expectedRevision, move) =>
		ipcRenderer.invoke('team:board-move', id, expectedRevision, move) as Promise<BoardSnapshot>,
	boardOwner: (id, expectedRevision, owner) =>
		ipcRenderer.invoke(
			'team:board-owner',
			id,
			expectedRevision,
			owner,
		) as Promise<BoardSnapshot>,
	clipboardImage: () => ipcRenderer.invoke('team:clipboard-image') as Promise<string>,
	roomImage: (id) => ipcRenderer.invoke('team:room-image', id) as Promise<RoomImage>,
	roomSend: (text, replyTo, image) =>
		ipcRenderer.invoke('team:room-send', text, replyTo, image) as Promise<LocalEvent>,
	ready: () => ipcRenderer.invoke('team:ready') as Promise<TeamSnapshot>,
	select: (slug) => ipcRenderer.invoke('team:select', slug) as Promise<void>,
	dismissResponse: (slug, nonce, id) =>
		ipcRenderer.invoke('team:dismiss-response', slug, nonce, id) as Promise<void>,
	start: (slug) => ipcRenderer.invoke('team:start', slug) as Promise<void>,
	stop: (slug, confirmed) =>
		ipcRenderer.invoke('team:stop', slug, confirmed) as Promise<StopResult>,
	stopRest: (slug, confirmation) =>
		ipcRenderer.invoke('team:stop-rest', slug, confirmation) as Promise<void>,
	hibernate: (slug, active) =>
		ipcRenderer.invoke('team:hibernate', slug, active) as Promise<void>,
	input: (slug, data, humanInput = true) =>
		ipcRenderer.send('team:input', slug, data, humanInput),
	resize: (slug, cols, rows) => ipcRenderer.send('team:resize', slug, cols, rows),
	onEvent: (listener) => {
		ipcRenderer.on('team:event', (_event, value: TeamEvent) => listener(value));
	},
};
contextBridge.exposeInMainWorld('team', bridge);
