import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { launchReady, observeLaunch } from './launch-phase.ts';
import { atomicWrite, errorCode, locked, missing, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { parseOwner, processAlive } from './process-owner.ts';
import { startedAfterLock } from './process-start.ts';
import { slugFor, storageRoot } from './store.ts';

export interface DeliveryState {
	nonce: string;
	pid: number;
	state: 'queued-only' | 'unconfirmed' | 'live';
	reason: string;
	thread: string;
}

export const awaitingReadinessReason =
	'Awaiting explicit launch readiness acknowledgment via summon --mail ready. Notices may already be arriving.';

/** Starts every reason a provider gives for holding notices, so a cleared hold can be found. */
export const noticesHeldPrefix = 'Notices held for ';

export const runtimePath = (name: string): string =>
	resolve(storageRoot(), 'runtime', slugFor(name));

export type ReceiverLease = (() => Promise<void>) & { owns: () => Promise<boolean> };

export async function deliveryStatus(
	name: string,
	nonce = process.env.SUMMON_NONCE,
): Promise<DeliveryState> {
	ownMailbox(name);
	if (!nonce || !/^[a-z0-9-]+$/i.test(nonce)) throw new Error('Invalid launch nonce.');
	const text = await optionalText(join(runtimePath(name), `${nonce}.json`));
	if (!text)
		return {
			nonce,
			pid: process.pid,
			state: 'queued-only',
			reason: 'No live adapter attached.',
			thread: '',
		};
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== 'object') throw new Error('Invalid delivery status.');
	const candidate = value as Record<string, unknown>;
	if (
		candidate.nonce !== nonce ||
		typeof candidate.pid !== 'number' ||
		typeof candidate.reason !== 'string' ||
		typeof candidate.thread !== 'string' ||
		!['queued-only', 'unconfirmed', 'live'].includes(String(candidate.state))
	)
		throw new Error('Invalid delivery status.');
	const result = value as DeliveryState;
	if (result.state === 'live' && !processAlive(result.pid))
		return {
			...result,
			state: 'queued-only',
			reason: 'Receiver process exited; mail remains queued.',
		};
	return result;
}

/** Project readiness independently; reading status never advances receiver health. */
export async function deliveryView(name: string) {
	const status = await deliveryStatus(name);
	const readinessConfirmed =
		(await optionalText(join(runtimePath(name), `${status.nonce}.ready`))) === status.nonce;
	return {
		...status,
		readinessConfirmed,
		reason:
			readinessConfirmed &&
			status.state === 'unconfirmed' &&
			status.reason === awaitingReadinessReason
				? 'Launch readiness acknowledged. Retained receiver status does not confirm delivery health.'
				: status.reason,
	};
}

export async function saveDelivery(name: string, state: DeliveryState): Promise<void> {
	ownMailbox(name);
	if (!/^[a-z0-9-]+$/i.test(state.nonce)) throw new Error('Invalid launch nonce.');
	const path = join(runtimePath(name), `${state.nonce}.json`);
	const text = JSON.stringify(state);
	if ((await optionalText(path)) !== text) await atomicWrite(path, text);
}

export async function markReady(name: string, nonce: string): Promise<void> {
	if (nonce !== process.env.SUMMON_NONCE)
		throw new Error('Readiness nonce does not match this session.');
	const current = await deliveryStatus(name, nonce);
	const raw = await optionalText(join(runtimePath(name), 'receiver/owner.json'));
	let active = false;
	if (raw) {
		try {
			const owner = parseOwner(raw);
			const value: unknown = JSON.parse(raw);
			active =
				!!owner &&
				processAlive(owner.pid) &&
				!!value &&
				typeof value === 'object' &&
				'launchNonce' in value &&
				value.launchNonce === nonce;
		} catch {
			/* Invalid ownership never establishes readiness. */
		}
	}
	if (current.state !== 'unconfirmed' && current.state !== 'live' && !active)
		throw new Error('No adapter awaiting readiness.');
	await atomicWrite(join(runtimePath(name), `${nonce}.ready`), nonce);
	await observeLaunch(launchReady(name, nonce));
}

export async function acquireReceiver(
	name: string,
	nonce: string,
): Promise<ReceiverLease | undefined> {
	const root = runtimePath(name);
	await mkdir(root, { recursive: true, mode: 0o700 });
	return locked(join(root, 'receiver-acquire.lock'), async () => {
		const lease = join(root, 'receiver');
		const info = await lstat(lease).catch((error: unknown) => {
			if (missing(error)) return undefined;
			throw error;
		});
		if (info) {
			const ownerPath = join(lease, 'owner.json');
			const owner = parseOwner((await optionalText(ownerPath)) ?? '');
			if (owner && processAlive(owner.pid)) {
				const ownerInfo = await lstat(ownerPath);
				if (!(await startedAfterLock(owner.pid, ownerInfo.mtimeMs))) return undefined;
			} else if (!owner && Date.now() - info.mtimeMs < 5000) return undefined;
			const identity = owner?.nonce ?? `ownerless-${info.ino}-${info.birthtimeMs}`;
			// Ownerless tombstones must also be nonempty so they cannot be overwritten on POSIX.
			if (!owner)
				await writeFile(join(lease, 'reclaimed'), identity, { flag: 'wx' }).catch(
					(error: unknown) => {
						if (errorCode(error) !== 'EEXIST') throw error;
					},
				);
			try {
				await rename(lease, join(root, `stale-${identity}`));
			} catch (error: unknown) {
				if (
					missing(error) ||
					['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(errorCode(error) ?? '')
				)
					return undefined;
				throw error;
			}
		}
		const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID(), launchNonce: nonce });
		const candidate = join(root, `receiver-pending-${randomUUID()}`);
		await mkdir(candidate, { mode: 0o700 });
		try {
			await writeFile(join(candidate, 'owner.json'), owner, { mode: 0o600 });
			await rename(candidate, lease);
		} finally {
			await rm(candidate, { recursive: true, force: true });
		}
		const owns = async (): Promise<boolean> =>
			(await optionalText(join(lease, 'owner.json'))) === owner;
		return Object.assign(
			async () => {
				if ((await optionalText(join(lease, 'owner.json'))) === owner)
					await rm(lease, { recursive: true });
			},
			{ owns },
		);
	});
}
