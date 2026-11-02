import type { CommunicationStatus } from '../communication-state.ts';
import type { DiaryPage } from '../diary.ts';
import type { HeadDownView } from '../head-down-model.ts';
import type { LaunchPhaseView } from '../launch-phase-model.ts';
import type { ModelInfo } from '../model-info.ts';
import type { NotepadSnapshot } from '../notepad.ts';
import type { OperatorIdentity } from '../operator-identity-model.ts';
import type { ProviderSetupCatalog } from '../provider-setup.ts';
import type { RepositoryDetail, RepositoryDiff, RepositoryList } from '../repository-model.ts';
import type { responseStatus } from '../response-watchdog-store.ts';
import type { RoomProgress } from '../room-progress.ts';
import type { RuntimeFaultInput } from '../runtime-fault-model.ts';
import type { RuntimePrerequisiteStatus } from '../runtime-prerequisites.ts';
import type { ScheduleView } from '../schedule-view.ts';
import type { Provider } from '../store.ts';
import type { TeamMacro } from '../team-macros.ts';
import type { TeamSettings } from '../team-settings.ts';
import type { GallerySnapshot } from '../teammate-templates.ts';
import type { CliStatus } from './cli-status.ts';
import type { NotificationPauseView } from './notification-pause.ts';
import type { PageState } from './page-state.ts';

export type { RuntimeFaultInput } from '../runtime-fault-model.ts';

export interface TeamAgent {
	responseWatchdog?: Awaited<ReturnType<typeof responseStatus>>;
	responseWatchdogError?: string;
	launch?: LaunchPhaseView;
	launchEnded?: LaunchPhaseView;
	claudeConfigDir?: string;
	claudeConfigInherited?: boolean;
	roomProgress?: RoomProgress;
	headDown?: HeadDownView;
	canManageHeadDown?: boolean;
	slug: string;
	name: string;
	/** The stored role, never inferred from the name or from a rest-stop grant (#5734). */
	memberType?: 'teammate' | 'pm';
	provider: Provider;
	modelInfo?: ModelInfo;
	cwd: string;
	/**
	 * `elsewhere` is a session held outside this window whose process identity is verified;
	 * `unknown` is a held lock whose process could not be verified, so it is neither online nor
	 * startable (verified-member-presence).
	 */
	status: 'offline' | 'running' | 'elsewhere' | 'unknown' | 'exited' | 'stopped' | 'hibernated';
	/** Why a held-elsewhere session reads `elsewhere` or `unknown`, and when that was observed. */
	presence?: { reason: string; observedAt: string };
	exitCode?: number;
	ownedSession?: boolean;
	/** The owned child is running, but its current saved status could not be observed. */
	observationUnavailable?: true;
	/** Authenticated compaction currently observed in this window's exact owned Claude launch. */
	nativeCompacting?: true;
	/** The provider's own turn record for this window's owned launch, when it is not idle. */
	providerTurn?: 'busy' | 'unknown';
	/**
	 * Stop was pressed and taskkill reported a failure, so the operator's intent is kept until the
	 * terminal reports its exit. Nothing is terminated again meanwhile (owned-session-stop.ts).
	 */
	stopUnverified?: true;
	restConfirmation?: string;
	workingOn?: string;
	activity?: 'idle' | 'busy' | 'needs-user';
	unreadMail?: number;
	avatar?: string;
	expertise?: string;
	domain?: string;
	/**
	 * Who is recorded as covering this teammate's domain; '' for nobody. Stored as `backup` on the
	 * profile, and named for what the UI says - "Covered by" - so one relationship does not carry a
	 * different name in storage, in the renderer and on the form. Three names for one arrow is why
	 * three of us had to verify its direction separately before it was relabelled (#1482).
	 */
	coveredBy?: string;
}

export interface TeamSnapshot {
	operator?: OperatorIdentity;
	/** Identity refused; other roster features remain usable and no human name is substituted. */
	operatorError?: string;
	notificationPause?: NotificationPauseView;
	startedAt?: string;
	agents: TeamAgent[];
	selected: string;
	/** The team this window opened, absent for the default one. Names the window in the sidebar. */
	team?: string;
	windowsPty?: { backend: 'conpty' | 'winpty'; buildNumber: number };
}

export type TeamEvent =
	| { type: 'snapshot'; value: TeamSnapshot }
	| { type: 'reset'; slug: string }
	| { type: 'output'; slug: string; data: string }
	/** The board file changed under us. Carries no payload; the renderer re-reads it. */
	| { type: 'board' }
	| {
			type: 'error';
			message: string;
			slug?: string;
			source?: string;
			diagnosticHandled?: boolean;
			diagnosticSaved?: boolean;
	  };

/**
 * What team:stop answers: it stopped the session, the operator has to be asked first, or the stop
 * is unverified. Unverified is neither success nor an error: termination was attempted once and
 * the terminal has not reported its exit. `rootChecked` is false when the session's root process
 * could not be read; `detail` is the diagnostic for the fault journal, not for the banner.
 */
export type StopResult =
	| { needsConfirm: true }
	| { stopped: true }
	| { unverified: true; rootChecked: boolean; detail: string };

export interface TeamBridge {
	dismissResponse: (slug: string, nonce: string, id: string) => Promise<void>;
	faultReport: (input: RuntimeFaultInput) => Promise<void>;
	/** Fire-and-forget: the page's last-known layout for renderer-failure records (page-state.ts). */
	pageState: (state: PageState) => void;
	providerSetup: () => Promise<ProviderSetupCatalog>;
	gallery: () => Promise<GallerySnapshot>;
	pauseNotifications: (paused: boolean) => Promise<void>;
	headDownDecision: (slug: string, id: string, approve: boolean) => Promise<void>;
	headDownEnd: (slug: string, id: string, reason: string) => Promise<void>;
	headDownDelegate: (slug: string, enabled: boolean) => Promise<void>;
	cliStatus: () => Promise<CliStatus[]>;
	runtimePrerequisites: () => Promise<RuntimePrerequisiteStatus[]>;
	installedProviders: () => Promise<Provider[]>;
	openRoomUrl: (url: string) => Promise<void>;
	chooseFolder: () => Promise<string | null>;
	settings: () => Promise<TeamSettings>;
	saveSettings: (value: Partial<TeamSettings>) => Promise<TeamSettings>;
	macros: () => Promise<TeamMacro[]>;
	saveMacros: (value: TeamMacro[]) => Promise<TeamMacro[]>;
	openRepository: () => Promise<void>;
	usage: (slug: string) => Promise<UsageReport>;
	profile: (slug: string) => Promise<TeamProfile>;
	/** The saved name, and a Kilo variant "check skipped" note when the save carries one. */
	saveProfile: (
		profile: TeamProfile,
		existing: string | null,
	) => Promise<{ slug: string; note?: string }>;
	removeProfile: (slug: string, archive: boolean) => Promise<void>;
	onImagePaste: (listener: () => void) => void;
	shells: () => Promise<ShellChoice[]>;
	operatorStart: (id: string, cols: number, rows: number) => Promise<void>;
	operatorStop: () => Promise<void>;
	operatorCopy: (text: string) => Promise<void>;
	operatorInput: (data: string) => void;
	operatorResize: (cols: number, rows: number) => void;
	onOperatorEvent: (listener: (event: OperatorEvent) => void) => void;
	roomRead: (after: number) => Promise<RoomPage>;
	roomTail: () => Promise<number>;
	clipboardImage: () => Promise<string>;
	roomImage: (id: string) => Promise<RoomImage>;
	roomSend: (text: string, replyTo: number | null, image?: string) => Promise<LocalEvent>;
	roomAnswer: (id: number, choice: number | null, text?: string) => Promise<LocalEvent>;
	boardRead: () => Promise<BoardSnapshot>;
	diaryRead: (before?: string, search?: string) => Promise<DiaryPage>;
	notepadRead: () => Promise<NotepadSnapshot>;
	notepadSave: (text: string, revision: string) => Promise<NotepadSnapshot>;
	scheduleView: () => Promise<ScheduleView>;
	reposList: () => Promise<RepositoryList>;
	reposDetail: (id: string) => Promise<RepositoryDetail>;
	reposDiff: (id: string, value: RepositoryDiff) => Promise<string>;
	reposOpen: (id: string, target: 'folder' | 'code') => Promise<void>;
	boardMove: (id: string, expectedRevision: number, move: BoardMove) => Promise<BoardSnapshot>;
	boardOwner: (id: string, expectedRevision: number, owner: string) => Promise<BoardSnapshot>;
	ready: () => Promise<TeamSnapshot>;
	select: (slug: string) => Promise<void>;
	start: (slug: string) => Promise<void>;
	stop: (slug: string, confirmed: boolean) => Promise<StopResult>;
	stopRest: (slug: string, confirmation: string) => Promise<void>;
	hibernate: (slug: string, active: boolean) => Promise<void>;
	input: (slug: string, data: string, humanInput?: boolean) => void;
	resize: (slug: string, cols: number, rows: number) => void;
	onEvent: (listener: (event: TeamEvent) => void) => void;
}
export interface ShellChoice {
	id: string;
	label: string;
}
export type OperatorEvent =
	| { type: 'started'; shell: string; cwd: string }
	| { type: 'output'; data: string }
	| { type: 'exited'; exitCode: number };
/**
 * The moves the board panel offers, named rather than expressed as fields. The bridge carries the
 * verb and board-ipc.ts owns the only translation of it, so the renderer has no way to write a card
 * field that nobody put a button on.
 *
 * `unblock` and `approve` are separate because the board says they are separate. Measured on the
 * first fifteen real cards: fourteen sat in `blocked` waiting on a decision from the operator and
 * not one sat in `review`. Accepting finished work and saying "go ahead" are different acts with
 * different outcomes, and a board that only offered the first would have had no usable button on any
 * card that existed the day it shipped.
 */
export type BoardMove = 'approve' | 'archive' | 'backlog' | 'promote' | 'unblock';
import type { BoardSnapshot } from '../board-model.ts';
import type { LocalEvent } from '../local-room.ts';
import type { TeamProfile } from '../team-maintenance.ts';
import type { UsageReport } from './usage.ts';

/** A room image and the size it will paint at, so its box can be reserved first. */
export interface RoomImage {
	data: string;
	height: number;
	width: number;
}

export interface RoomPage {
	events: LocalEvent[];
	nextCursor: number;
	more: boolean;
	paused: boolean;
	communication: CommunicationStatus;
}

declare global {
	interface Window {
		team: TeamBridge;
	}
}
