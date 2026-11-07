import { z } from 'zod';

import { version } from '../package.json';
import { cliStatuses } from './desktop/cli-status.ts';
import {
	DIAGNOSTIC_REDACTIONS,
	diagnosticError,
	diagnosticReason,
	diagnosticRuntimeDetail,
} from './diagnostics-privacy.ts';
import { readLaunchStatus } from './launch-status.ts';
import { deliveryView } from './mail-session.ts';
import { presenceRows } from './presence-command.ts';
import { readRuntimeFaults } from './runtime-faults.ts';
import { probeRuntimePrerequisites } from './runtime-prerequisite-probe.ts';
import { readSessionHistory } from './session-history.ts';
import { wakeDeliverySnapshot } from './wake-delivery-store.ts';
import { wakeErrors } from './wake-errors.ts';
import { workView } from './work-view.ts';

export interface DiagnosticSection {
	status: 'available' | 'unavailable';
	value?: unknown;
	error?: string;
}

const buildIdentity = z.object({
	kind: z.string().max(100),
	version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i),
	revision: z.string().regex(/^(?:[a-f0-9]{7,40}|unversioned)(?:\+dirty)?$/),
	buildId: z.string().regex(/^[a-f0-9]{10}$/),
	builtAt: z.iso.datetime(),
});

export interface DiagnosticSources {
	build: () => Promise<unknown>;
	launch: () => Promise<Awaited<ReturnType<typeof readLaunchStatus>>>;
	presence: () => Promise<Awaited<ReturnType<typeof presenceRows>>>;
	mail: (member: string) => Promise<{
		state: string;
		readinessConfirmed: boolean;
		reason: string;
		wakeErrors: {
			stage: string;
			certainty: string;
			failedAt: string;
			recoveredAt?: string | undefined;
		}[];
		wakeDelivery: {
			latest: { state: string; attempts: number; updatedAt: string } | null;
			unresolved: number;
		};
	}>;
	work: () => Promise<Awaited<ReturnType<typeof workView>>>;
	faults: (
		member: string,
		since: string,
	) => Promise<Awaited<ReturnType<typeof readRuntimeFaults>>>;
	history: (member: string) => Promise<Awaited<ReturnType<typeof readSessionHistory>>>;
	prerequisites: () => Promise<Awaited<ReturnType<typeof probeRuntimePrerequisites>>>;
	providers: () => Promise<Awaited<ReturnType<typeof cliStatuses>>>;
}

const defaults: Omit<DiagnosticSources, 'build'> = {
	launch: readLaunchStatus,
	presence: presenceRows,
	mail: async (member) => {
		const delivery = await deliveryView(member);
		return {
			state: delivery.state,
			readinessConfirmed: delivery.readinessConfirmed,
			reason: delivery.reason,
			wakeErrors: await wakeErrors(member),
			wakeDelivery: await wakeDeliverySnapshot(member, delivery.nonce),
		};
	},
	work: workView,
	faults: (member, since) => readRuntimeFaults({ member, since, limit: 200 }),
	history: (member) => readSessionHistory({ member, limit: 200 }),
	prerequisites: probeRuntimePrerequisites,
	providers: cliStatuses,
};

function section(value: unknown): DiagnosticSection {
	return { status: 'available', value };
}

async function inspect(read: () => Promise<unknown>): Promise<DiagnosticSection> {
	try {
		return section(await read());
	} catch (error: unknown) {
		return { status: 'unavailable', error: diagnosticError(error) };
	}
}

/** Explicit projection prevents a future status field from silently copying private content. */
export async function collectDiagnostics(
	member: string,
	since: string,
	build: DiagnosticSources['build'],
	sources: Partial<Omit<DiagnosticSources, 'build'>> = {},
	now = new Date().toISOString(),
) {
	const readers = { ...defaults, ...sources };
	const sections = {
		identity: section({
			version,
			runtime: {
				name: 'Bun',
				version: Bun.version,
				platform: process.platform,
				arch: process.arch,
			},
		}),
		build: await inspect(async () => buildIdentity.parse(await build())),
		prerequisites: await inspect(async () =>
			(await readers.prerequisites()).map(({ id, status, detail }) => ({
				id,
				status,
				detail: diagnosticRuntimeDetail(id, status, detail),
			})),
		),
		providerClis: await inspect(async () =>
			(await readers.providers()).map(({ provider, status, detail }) => {
				const version = detail.match(
					/\b\d{1,9}\.\d{1,9}\.\d{1,9}(?:[-+][a-z0-9.-]{1,32})?\b/i,
				)?.[0];
				return {
					provider,
					status,
					detail:
						status === 'available'
							? version
								? `${provider} ${version}`
								: 'Version not reported'
							: diagnosticReason(detail),
				};
			}),
		),
		launchStatus: await inspect(async () => {
			const value = await readers.launch();
			return {
				current: value.current,
				reason: 'reason' in value ? diagnosticReason(value.reason) : undefined,
				observedAt: 'observedAt' in value ? value.observedAt : undefined,
				member: (() => {
					const own = value.members.find((item) => item.slug === member);
					return own
						? {
								provider: own.provider,
								phase: own.launch.phase,
								since: own.launch.since,
							}
						: null;
				})(),
			};
		}),
		presence: await inspect(async () => {
			const row = (await readers.presence()).find((item) => item.slug === member);
			return row
				? {
						state: row.state,
						provider: row.provider,
						reason: diagnosticReason(row.reason),
						observedAt: row.observedAt,
						hibernated: row.hibernated,
					}
				: { state: 'unavailable', reason: 'Own presence row is absent.' };
		}),
		mailStatus: await inspect(async () => {
			const raw = await readers.mail(member);
			return {
				state: raw.state,
				readinessConfirmed: raw.readinessConfirmed,
				reason: diagnosticReason(raw.reason),
				wakeErrors: raw.wakeErrors.map((item) => ({
					stage: item.stage,
					certainty: item.certainty,
					failedAt: item.failedAt,
					recoveredAt: item.recoveredAt ?? null,
				})),
				wakeDelivery: raw.wakeDelivery,
			};
		}),
		work: await inspect(async () => {
			const raw = await readers.work();
			return {
				activity: { currentLaunch: raw.activity.currentLaunch, state: raw.activity.state },
				cards: { count: raw.cards.count },
				mail: {
					pending: raw.mail.pending,
					unread: raw.mail.unread,
					invalidCount: raw.mail.invalid.length,
				},
				holds: { pending: raw.holds.pending, decisions: raw.holds.decisions },
				checkpoint: {
					phase: raw.checkpoint.phase,
					page: raw.checkpoint.page,
					pages: raw.checkpoint.pages,
				},
				schedules: { counts: raw.schedules.counts },
				rest: raw.rest ? { mode: raw.rest.mode } : null,
				headDown: raw.headDown ? { phase: raw.headDown.phase } : null,
				roomAcknowledgedThrough: raw.roomAcknowledgedThrough,
			};
		}),
		faults: await inspect(async () => {
			const raw = await readers.faults(member, since);
			return {
				more: raw.more,
				matchingOccurrences: 'matchingOccurrences' in raw ? raw.matchingOccurrences : 0,
				entries: raw.entries.map((item) => ({
					at: item.at,
					lastAt: item.lastAt,
					level: item.level,
					source: item.source,
					count: item.count,
					text: diagnosticReason(item.text),
				})),
			};
		}),
		sessionHistory: await inspect(async () => {
			const raw = await readers.history(member);
			return {
				more: raw.more,
				entries: raw.entries
					.filter((item) => item.at >= since)
					.map((item) => ({
						at: item.at,
						state: item.state,
						reason: item.reason,
						provider: item.provider,
						exitCode: item.exitCode ?? null,
					})),
			};
		}),
	};
	const unavailable = Object.entries(sections)
		.filter(([, value]) => value.status === 'unavailable')
		.map(([name]) => name);
	return {
		format: 1,
		member,
		capturedAt: now,
		since,
		redactions: [...DIAGNOSTIC_REDACTIONS],
		summary: `Summon diagnostics for ${member}, ${since} to ${now}. ${unavailable.length ? `Unavailable: ${unavailable.join(', ')}.` : 'All sections available.'}`,
		sections,
	};
}
