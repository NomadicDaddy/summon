import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import type { TeamSnapshot } from './desktop/types.ts';

import { processStart } from './checkpoint-offline-runtime.ts';
import { launchPhaseSchema } from './launch-phase-model.ts';
import { atomicWrite, locked, missing } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import { providers, storageRoot } from './store.ts';

const maxAge = 10000;
const maxBytes = 256 * 1024;
const launch = launchPhaseSchema.pick({ phase: true, since: true, evidence: true });
const publicMember = z.object({
	slug: z
		.string()
		.max(64)
		.regex(/^[a-z0-9][a-z0-9._-]*$/),
	provider: z.enum(providers),
	launch,
});
const snapshot = z.object({
	version: z.literal(1),
	pid: z.number().int().positive(),
	windowStartedAt: z.iso.datetime(),
	observedAt: z.iso.datetime(),
	complete: z.boolean(),
	members: z.array(publicMember),
});
const path = (): string => join(storageRoot(), 'runtime/team-window/launch-status.json');

async function snapshotText(): Promise<string | undefined> {
	try {
		const info = await lstat(path());
		if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes)
			throw new Error('Invalid public launch snapshot.');
		const handle = await open(path(), 'r');
		try {
			const opened = await handle.stat();
			if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino)
				throw new Error('Public launch snapshot changed while opening.');
			const bytes = Buffer.alloc(maxBytes + 1);
			let offset = 0;
			while (offset < bytes.length) {
				const { bytesRead } = await handle.read(
					bytes,
					offset,
					bytes.length - offset,
					offset,
				);
				if (bytesRead === 0) break;
				offset += bytesRead;
			}
			if (offset > maxBytes) throw new Error('Public launch snapshot exceeds its bound.');
			return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
		} finally {
			await handle.close();
		}
	} catch (error: unknown) {
		if (missing(error)) return undefined;
		throw error;
	}
}

/** Publish only the phases the owning window exposes publicly, never private session evidence. */
export async function publishLaunchStatus(
	value: TeamSnapshot,
	sampledAt: number,
	reported: Set<string>,
	report: (message: string) => void,
	ownedRunning: readonly string[],
): Promise<void> {
	try {
		operatorOnly();
		const next = snapshot.parse({
			version: 1,
			pid: process.pid,
			windowStartedAt: value.startedAt,
			observedAt: new Date(sampledAt).toISOString(),
			complete: ownedRunning.every((slug) =>
				value.agents.some(
					(agent) =>
						agent.slug === slug && agent.ownedSession && !agent.observationUnavailable,
				),
			),
			members: value.agents
				.filter(
					(agent) =>
						agent.ownedSession &&
						agent.status === 'running' &&
						!agent.observationUnavailable &&
						agent.launch,
				)
				.map((agent) => ({
					slug: agent.slug,
					provider: agent.provider,
					launch: agent.launch,
				})),
		});
		const text = JSON.stringify(next);
		if (Buffer.byteLength(text) > maxBytes)
			throw new Error('Public snapshot exceeds its bound.');
		await locked(`${path()}.lock`, async () => {
			let previous: unknown;
			try {
				previous = JSON.parse((await snapshotText()) ?? 'null') as unknown;
			} catch {
				previous = undefined;
			}
			const prior = snapshot.safeParse(previous);
			if (
				prior.success &&
				prior.data.pid === next.pid &&
				prior.data.windowStartedAt === next.windowStartedAt &&
				Date.parse(prior.data.observedAt) > sampledAt
			)
				return;
			await atomicWrite(path(), text);
		});
		reported.delete('launch-status');
	} catch {
		if (!reported.has('launch-status')) {
			reported.add('launch-status');
			report(
				'Public launch status could not be saved; the Team Window display remains available.',
			);
		}
	}
}

/** Unavailable evidence is explicit: an empty retained file never proves nobody is launching. */
export async function readLaunchStatus(now = Date.now()) {
	const unavailable = (reason: string) => ({ current: false as const, reason, members: [] });
	const began = performance.now();
	try {
		const value = snapshot.parse(JSON.parse((await snapshotText()) ?? 'null') as unknown);
		if (!value.complete)
			return unavailable(
				'An owned running member could not be observed; launch status is incomplete.',
			);
		const observed = Date.parse(value.observedAt),
			startedAt = Date.parse(value.windowStartedAt);
		if (
			observed > now ||
			startedAt > observed ||
			now - observed > maxAge ||
			value.members.some(
				(member) =>
					Date.parse(member.launch.since) > now ||
					Date.parse(member.launch.since) < startedAt,
			)
		)
			return unavailable('Public launch snapshot is stale or its clock is unverifiable.');
		const started = await processStart(value.pid);
		if (typeof started !== 'number' || started > startedAt)
			return unavailable(
				'Owning window process identity is unavailable or no longer matches.',
			);
		if (now + performance.now() - began - observed > maxAge)
			return unavailable('Public launch snapshot expired during identity verification.');
		return {
			current: true as const,
			windowStartedAt: value.windowStartedAt,
			observedAt: value.observedAt,
			members: value.members,
		};
	} catch {
		return unavailable('Public launch snapshot is missing, unreadable or invalid.');
	}
}
