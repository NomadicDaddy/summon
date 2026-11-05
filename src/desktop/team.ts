import type { IPty, IPtyForkOptions } from 'node-pty';

import { randomUUID } from 'node:crypto';

import type { OwnedLaunch } from '../launch-phase-model.ts';
import type { LocalEvent } from '../local-room.ts';
import type { SessionTransitionInput } from '../session-history.ts';
import type { NotificationPauseView } from './notification-pause.ts';
import type { SessionStop, StopOutcome, StopReason, StopRoot } from './owned-session-stop.ts';
import type { TeamAgent, TeamEvent, TeamSnapshot } from './types.ts';

import { readActivity } from '../agent-activity.ts';
import { claudeConfigDirectory } from '../claude-config.ts';
import { claudeDelivery } from '../claude-delivery.ts';
import { isHibernated, setHibernation } from '../hibernation.ts';
import { memberLabel } from '../member-role.ts';
import { isAgentRunning } from '../session-lock.ts';
import { sessionStorageArguments, sessionStorageEnvironment } from '../storage-launch.ts';
import { loadAgent, slugFor } from '../store.ts';
import { retainEndedLaunch } from './launch-phase-view.ts';
import { recoverMissedMentionWakes } from './mention-recovery.ts';
import { captureRoot, requireVerified, stopOwnedSession } from './owned-session-stop.ts';
import { inputToOwnedTerminal, resizeOwnedTerminal } from './owned-terminal-input.ts';
import { childEnvironment, killProcessTree } from './pty-process.ts';
import { sessionTransitions } from './session-transitions.ts';
import { publicTeamSnapshot } from './team-public-snapshot.ts';
import { teamSelection } from './team-selection.ts';
import { retainFailedMention } from './team-wake-errors.ts';
import { flushTeamMentionWakes, wakeTeamMentions } from './team-wakes.ts';
import {
	stopTerminalReceivers,
	syncTerminalReceivers,
	wakeTerminalReceiver,
} from './terminal-receivers.ts';
import { settleStops } from './window-shutdown.ts';

interface Session extends SessionStop {
	launch: OwnedLaunch;
	pty: TerminalProcess;
	agent: TeamAgent;
	previousActivityNonce: string | undefined;
	terminalNotices: boolean;
	previousLaunchNonce?: string;
}
export type TerminalProcess = Pick<IPty, 'pid' | 'onData' | 'onExit' | 'write' | 'resize' | 'kill'>;

/** Owns only PTYs started by this window. Existing external sessions are never adopted. */
export class Team {
	notificationPause?: () => NotificationPauseView;
	stopRoot?: StopRoot;
	readonly startedAt = new Date().toISOString();
	readonly sessions = new Map<string, Session>();
	selected = '';
	closing = false;
	private readonly starting = new Set<string>();
	private readonly stopping = new Map<string, Promise<StopOutcome>>();
	private readonly reported = new Set<string>();
	private readonly dimensions = new Map<string, { cols: number; rows: number }>();
	private readonly selectMember = teamSelection(this, (event) => this.emit(event));
	private readonly history = sessionTransitions(this.startedAt, () =>
		this.error(
			'Session history could not be saved; lifecycle evidence is incomplete.',
			undefined,
			'session-history.persistence',
		),
	);
	private readonly bun: string;
	private readonly cli: string;
	private readonly emit: (event: TeamEvent) => void;
	private readonly terminate: typeof killProcessTree;
	private readonly spawn: (
		file: string,
		args: string[],
		options: IPtyForkOptions,
	) => TerminalProcess;
	constructor(
		bun: string,
		cli: string,
		emit: (event: TeamEvent) => void,
		spawn: (file: string, args: string[], options: IPtyForkOptions) => TerminalProcess,
		terminate = killProcessTree,
	) {
		this.bun = bun;
		this.cli = cli;
		this.emit = emit;
		this.spawn = spawn;
		this.terminate = terminate;
	}

	async snapshot(): Promise<TeamSnapshot> {
		return publicTeamSnapshot(
			{
				sessions: this.sessions,
				reported: this.reported,
				emit: this.emit,
				startedAt: this.startedAt,
				selected: this.selected,
			},
			this.notificationPause?.(),
		);
	}

	async publish(): Promise<void> {
		const value = await this.snapshot();
		if (value.selected === this.selected) this.emit({ type: 'snapshot', value });
	}

	async select(name: string): Promise<void> {
		await this.selectMember(name);
	}

	async start(
		name: string,
		select = true,
		reason: SessionTransitionInput['reason'] = 'operator',
	): Promise<void> {
		if (this.closing) throw new Error('The team is shutting down.');
		const slug = slugFor(name);
		if (await isHibernated(slug)) {
			this.emit({
				type: 'error',
				message: `${slug} was not woken: hibernated by the operator.`,
				slug,
			});
			return;
		}
		if (this.starting.has(slug)) return;
		this.starting.add(slug);
		try {
			if (select) await this.select(slug);
			else if (!(await loadAgent(slug))) throw new Error('Agent no longer exists.');
			await this.stopping.get(slug);
			this.ensureOpen();
			if (this.sessions.get(slug)?.agent.status === 'running') return;
			if (await isAgentRunning(slug)) return;
			const record = await loadAgent(slug);
			if (!record) throw new Error('Agent no longer exists.');
			const env = sessionStorageEnvironment(childEnvironment());
			const launch = { nonce: randomUUID(), since: new Date().toISOString() };
			const args = [
				this.cli,
				'__session',
				slug,
				...sessionStorageArguments(),
				'--launch-nonce',
				launch.nonce,
			];
			const liveClaude = record.provider === 'claude' && (await claudeDelivery()) === 'live';
			if (liveClaude) args.push('--claude-mail-channel');
			else if (record.provider === 'claude') args.push('--claude-checkpoint');
			this.ensureOpen();
			this.emit({ type: 'reset', slug });
			const dimensions = this.dimensions.get(slug) ?? { cols: 100, rows: 30 };
			const terminalNotices =
				['grok', 'kilo'].includes(record.provider) ||
				(record.provider === 'claude' && !liveClaude);
			const previousActivityNonce = (await readActivity(slug))?.nonce;
			this.ensureOpen();
			const pty = this.spawn(this.bun, args, {
				cwd: record.cwd,
				env,
				...dimensions,
				name: 'xterm-256color',
			});
			const agent: TeamAgent = {
				...(record.provider === 'claude'
					? {
							claudeConfigDir: claudeConfigDirectory(record),
							claudeConfigInherited: record.claudeConfigDir === undefined,
						}
					: {}),
				slug,
				name: memberLabel(record),
				memberType: record.memberType ?? 'teammate',
				provider: record.provider,
				cwd: record.cwd,
				status: 'running',
			};
			const previousLaunchNonce = this.sessions.get(slug)?.launch.nonce;
			const session = {
				pty,
				agent,
				previousActivityNonce,
				terminalNotices,
				launch,
				rootStartedAt: captureRoot(this, pty.pid, slug, launch),
				...(previousLaunchNonce ? { previousLaunchNonce } : {}),
			};
			this.sessions.set(slug, session);
			const recorded = this.history.recordSession(session, 'started', reason);
			pty.onData((data) => this.emit({ type: 'output', slug, data }));
			pty.onExit(({ exitCode }) => {
				this.ended(slug, session, exitCode);
			});
			await recorded;
			await this.publish();
		} finally {
			this.starting.delete(slug);
		}
	}

	async wakeMentions(event: LocalEvent): Promise<void> {
		await wakeTeamMentions(this, event);
	}

	async recoverMissedMentionWakes(
		events: LocalEvent[],
		since: string | null | undefined,
	): Promise<void> {
		await recoverMissedMentionWakes(
			events,
			since,
			(slug) => this.sessions.get(slug)?.agent.status === 'running',
			(slug) => this.start(slug, false, 'recovery'),
			(slug) => this.error(`${slug} was not woken: hibernated by the operator.`, slug),
			(slug, through, error) => retainFailedMention(this, slug, through, error),
		);
		await this.flushPendingMentionWakes();
	}

	async flushPendingMentionWakes(): Promise<void> {
		await flushTeamMentionWakes(this);
	}

	async input(slug: string, data: string, humanInput = true): Promise<void> {
		await inputToOwnedTerminal(
			slug,
			data,
			humanInput,
			() => this.sessions.get(slug),
			wakeTerminalReceiver,
		);
	}

	async hibernate(slug: string, active: boolean): Promise<void> {
		await setHibernation(slug, active);
		await this.syncHibernation();
		if (!active) await this.start(slug, false, 'unhibernate');
		await this.publish();
	}

	async syncHibernation(): Promise<void> {
		await syncTerminalReceivers(this);
	}

	private ensureOpen(): void {
		if (this.closing) throw new Error('The team is shutting down.');
	}

	private ended(slug: string, session: Session, exitCode?: number): void {
		if (this.sessions.get(slug) !== session || session.agent.status !== 'running') return;
		void this.history.ended(session, exitCode);
		this.emit({
			type: 'output',
			slug,
			data: session.stopRequested
				? '\r\n[Session stopped]\r\n'
				: `\r\n[Session ended: ${exitCode}]\r\n`,
		});
		void this.publish().catch((error: unknown) => this.error(error));
		if (!session.stopRequested)
			void retainEndedLaunch(this, slug, session).catch((error: unknown) =>
				this.error(error, slug, 'launch'),
			);
	}

	resize(slug: string, cols: number, rows: number): void {
		resizeOwnedTerminal(slug, cols, rows, this.dimensions, this.sessions);
	}

	stop(slug: string, reason: StopReason = 'operator'): Promise<StopOutcome> {
		const previous = this.stopping.get(slug);
		if (previous) return previous;
		const pending = stopOwnedSession(
			this,
			slug,
			reason,
			this.history,
			this.terminate,
			(session) => this.ended(slug, session),
		).finally(() => {
			if (this.stopping.get(slug) === pending) this.stopping.delete(slug);
		});
		this.stopping.set(slug, pending);
		return pending;
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		try {
			await settleStops([
				stopTerminalReceivers(this),
				...[...this.sessions.keys()].map((slug) =>
					requireVerified(this.stop(slug, 'window-close')),
				),
			]);
		} finally {
			await this.history.flush();
		}
	}

	error(error: unknown, slug?: string, source?: string): void {
		this.emit({
			type: 'error',
			message: error instanceof Error ? error.message : String(error),
			...(slug === undefined ? {} : { slug }),
			...(source === undefined ? {} : { source }),
		});
	}
}
