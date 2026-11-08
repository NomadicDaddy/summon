import { release } from 'node:os';

import type { OwnedLaunch } from '../launch-phase-model.ts';
import type { Presence } from '../session-presence.ts';
import type { TeamAgent, TeamEvent, TeamSnapshot } from './types.ts';

import { readActivity } from '../agent-activity.ts';
import { claudeConfigDirectory } from '../claude-config.ts';
import { claudeTurn } from '../claude-turn-state.ts';
import { codexRosterTurns } from '../codex-turn.ts';
import { canManageHeadDown } from '../head-down-access.ts';
import { headDownView } from '../head-down-model.ts';
import { currentKiloProviderLimit } from '../kilo-provider-limit.ts';
import { observeGrokSession } from '../launch-phase.ts';
import { memberLabel } from '../member-role.ts';
import { refreshModelInfo } from '../provider-model-info.ts';
import { providerTurn } from '../provider-turn.ts';
import { responseStatusView } from '../response-watchdog-store.ts';
import { readRest } from '../rest.ts';
import { roomProgress } from '../room-progress.ts';
import { isAgentRunning } from '../session-lock.ts';
import { listAgentSlugs, loadAgent } from '../store.ts';
import { avatarFor, retainAvatars } from './avatar.ts';
import { externalPresence, heldStatus } from './external-presence.ts';
import { ownedLaunchView } from './launch-phase-view.ts';
import { unreadMailCount } from './mail-count.ts';
import { pinManagers } from './roster-order.ts';
interface SnapshotContext {
	sessions: ReadonlyMap<string, { agent: TeamAgent; launch: OwnedLaunch }>;
	reported: Set<string>;
	emit: (event: TeamEvent) => void;
	startedAt: string;
	selected: string;
}
/**
 * Claude's turn record for the compacting mark. An unreadable record hides only the mark:
 * providerTurn reads it as 'unknown', so Stop asks and the row stays whole rather than "cannot
 * load". The fault is reported once, until the record reads cleanly again.
 */
async function nativeClaudeTurn(context: SnapshotContext, slug: string, nonce: string) {
	const key = `claude-turn:${slug}`;
	try {
		const value = await claudeTurn(slug, nonce);
		context.reported.delete(key);
		return value;
	} catch {
		if (!context.reported.has(key)) {
			context.reported.add(key);
			context.emit({
				type: 'error',
				source: 'claude-turn',
				slug,
				message:
					'Claude turn record could not be read; Stop asks before ending this session.',
			});
		}
		return undefined;
	}
}

/**
 * Members this window has no session for whose launch lock is held, with their presence from one
 * shared snapshot. The guard decides Start; presence decides only whether the row may read online.
 */
async function heldElsewhere(slugs: Set<string>, context: SnapshotContext) {
	const members: { slug: string; provider: string }[] = [];
	for (const slug of slugs) {
		if (context.sessions.has(slug) || !(await isAgentRunning(slug))) continue;
		const record = await loadAgent(slug).catch(() => undefined);
		members.push({ provider: record?.provider ?? 'unknown', slug });
	}
	const presence = await externalPresence(members);
	return new Map(members.map(({ slug }) => [slug, presence.get(slug)]));
}

function heldView(held: Map<string, Presence | undefined>, slug: string) {
	if (!held.has(slug)) return { status: 'offline' as const };
	const presence = held.get(slug);
	return {
		status: heldStatus(presence),
		...(presence
			? { presence: { observedAt: presence.observedAt, reason: presence.reason } }
			: {}),
	};
}

export async function teamSnapshot(context: SnapshotContext): Promise<TeamSnapshot> {
	const agents: TeamAgent[] = [];
	const slugs = new Set([
		...(await listAgentSlugs()),
		...[...context.sessions]
			.filter(([, session]) => session.agent.status === 'running')
			.map(([slug]) => slug),
	]);
	retainAvatars(slugs);
	const held = await heldElsewhere(slugs, context);
	const codexSessions = new Map(
		[...context.sessions].filter(
			([, session]) =>
				session.agent.status === 'running' && session.agent.provider === 'codex',
		),
	);
	const codex = await codexRosterTurns(
		[...codexSessions].map(([name, session]) => ({ name, nonce: session.launch.nonce })),
	);
	for (const slug of slugs) {
		const entry = `${slug}.json`;
		const session = context.sessions.get(slug);
		try {
			const record = await loadAgent(slug);
			if (!record) {
				if (session?.agent.status !== 'running') continue;
				throw new Error('Registration is unavailable for an owned running session.');
			}
			let activity = await readActivity(slug);
			const headDown = await headDownView(slug);
			// The roster observes committed state; wake and stop paths revalidate under the lock.
			const rest = await readRest(slug);
			const unreadMail = await unreadMailCount(slug);
			const avatar = await avatarFor(slug);
			const modelInfo = await refreshModelInfo(slug, record);
			const phaseError = `launch:${slug}`;
			if (
				session?.agent.status === 'running' &&
				session.agent.provider === 'grok' &&
				activity?.nonce === session.launch.nonce &&
				activity.launch?.phase === 'connecting'
			) {
				try {
					activity = await observeGrokSession(
						slug,
						session.launch.nonce,
						modelInfo,
						() =>
							context.sessions.get(slug) === session &&
							session.agent.status === 'running',
					);
					context.reported.delete(phaseError);
				} catch {
					if (!context.reported.has(phaseError)) {
						context.reported.add(phaseError);
						context.emit({
							type: 'error',
							source: 'launch',
							slug,
							message:
								'Launch phase update could not be saved; current status retained.',
						});
					}
				}
			} else context.reported.delete(phaseError);
			const current =
				!session || activity?.nonce === session.launch.nonce ? activity : undefined;
			const launch =
				session?.agent.status === 'running'
					? ownedLaunchView(session.launch, activity)
					: undefined;
			const native =
				session?.agent.status === 'running' &&
				session.agent.provider === 'claude' &&
				current?.nonce === session.launch.nonce
					? await nativeClaudeTurn(context, slug, session.launch.nonce)
					: undefined;
			const codexPhase = codexSessions.get(slug) === session ? codex.get(slug) : 'unknown';
			const turn =
				session?.agent.status === 'running' && context.sessions.get(slug) === session
					? session.agent.provider === 'codex'
						? codexPhase === 'idle'
							? undefined
							: (codexPhase ?? 'unknown')
						: await providerTurn(session.agent.provider, slug, session.launch.nonce)
					: undefined;
			let providerLimit: TeamAgent['providerLimit'];
			let providerLimitError = false;
			if (session?.agent.status === 'running' && session.agent.provider === 'kilo') {
				try {
					providerLimit = await currentKiloProviderLimit(
						slug,
						session.launch.nonce,
						session.launch.since,
						record,
					);
				} catch {
					providerLimitError = true;
				}
			}
			const progress = await roomProgress(slug);
			agents.push({
				...(session?.agent.status === 'running'
					? await responseStatusView(slug, session.launch.nonce)
					: {}),
				...(session?.agent ?? {
					slug,
					name: record.name,
					provider: record.provider,
					cwd: record.cwd,
					...(record.provider === 'claude'
						? {
								claudeConfigDir: claudeConfigDirectory(record),
								claudeConfigInherited: record.claudeConfigDir === undefined,
							}
						: {}),
					...heldView(held, slug),
				}),
				workingOn: current?.workingOn ?? '',
				...(context.sessions.get(slug) === session &&
				native?.attached &&
				native.compactions > 0
					? { nativeCompacting: true as const }
					: {}),
				...(turn ? { providerTurn: turn } : {}),
				...(providerLimit ? { providerLimit } : {}),
				...(providerLimitError ? { providerLimitError: true as const } : {}),
				...(launch ? { launch } : {}),
				name: memberLabel(record),
				memberType: record.memberType ?? 'teammate',
				...(headDown ? { headDown } : {}),
				canManageHeadDown: await canManageHeadDown(slug),
				...(modelInfo ? { modelInfo } : {}),
				...(progress ? { roomProgress: progress } : {}),
				...(rest?.mode === 'ready' && (!session || rest.nonce === session.launch.nonce)
					? { restConfirmation: rest.id }
					: {}),
				ownedSession: session?.agent.status === 'running',
				...(record.hibernation?.active ? { status: 'hibernated' as const } : {}),
				expertise: record.expertise,
				domain: record.domain ?? '',
				coveredBy: record.backup ?? '',
				activity: current?.state ?? 'idle',
				unreadMail,
				...(avatar ? { avatar } : {}),
			});
			context.reported.delete(entry);
		} catch (error: unknown) {
			if (session?.agent.status === 'running' && context.sessions.get(slug) === session) {
				agents.push({
					...session.agent,
					ownedSession: true,
					observationUnavailable: true,
				});
			}
			if (!context.reported.has(entry)) {
				context.reported.add(entry);
				context.emit({
					type: 'error',
					message: `Cannot load ${entry}: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
	}
	const buildNumber = Number(release().split('.')[2]);
	return {
		startedAt: context.startedAt,
		agents: pinManagers(agents),
		selected: context.selected,
		...(process.platform === 'win32' && Number.isSafeInteger(buildNumber)
			? {
					windowsPty: {
						backend: buildNumber >= 18309 ? ('conpty' as const) : ('winpty' as const),
						buildNumber,
					},
				}
			: {}),
	};
}
