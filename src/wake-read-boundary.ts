import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { CheckpointPackage } from './checkpoint-package-model.ts';
import type { WakePart } from './wake-part.ts';

import {
	checkpointHash,
	parseCheckpointPackage,
	parseCheckpointState,
} from './checkpoint-package-model.ts';
import {
	checkpointPackagePath,
	checkpointStatePath,
	validateCheckpointPackage,
} from './checkpoint-package-store.ts';
import { missing, optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { localCursorPath, roomCursor } from './room-cursor.ts';

interface CachedPackage {
	rawHash: string;
	packageId: string;
	expectedHash: string;
	page: number;
	createdAt: number;
	packet: CheckpointPackage;
}

// One current package per receiver path; terminal seats share this process.
const cachedPackages = new Map<string, CachedPackage>();

function evictPath(path: string): void {
	cachedPackages.delete(path);
}

function freezeValue(value: unknown): void {
	if (value === null || typeof value !== 'object') return;
	for (const child of Object.values(value)) freezeValue(child);
	Object.freeze(value);
}

export function wakePartCovered(part: WakePart, packet: CheckpointPackage): boolean {
	const target = part.target;
	if (target.source === 'room') return target.through <= packet.sources.room.through;
	if (target.source === 'telegram')
		return (
			packet.sources.telegram?.key === target.key &&
			target.through <= packet.sources.telegram.through
		);
	if (target.source === 'mail')
		return target.ids.every((id) =>
			packet.items.some((item) => item.source === 'mail' && item.id === id),
		);
	if (target.source === 'holds')
		return target.ids.every((key) => {
			const [, id, fingerprint] = key.split(':');
			return !!id && !!fingerprint && packet.sources.holds[id] === fingerprint;
		});
	return false;
}

/** Inspection only: a package currently being read suppresses covered notices, never new work. */
export async function activeWakeReadBoundary(
	name: string,
	receiverStartedAt: number,
): Promise<CheckpointPackage | undefined> {
	ownMailbox(name);
	const path = checkpointPackagePath(name);
	try {
		const state = parseCheckpointState(await optionalText(checkpointStatePath(name)));
		if (!state.current) {
			evictPath(path);
			return undefined;
		}
		let bytes: Buffer;
		try {
			bytes = await readFile(path);
		} catch (error: unknown) {
			if (missing(error))
				throw new Error('Active checkpoint package is missing.', { cause: error });
			throw error;
		}
		if (!bytes.length) throw new Error('Active checkpoint package is missing.');
		const rawHash = createHash('sha256').update(bytes).digest('hex');
		const cached = cachedPackages.get(path);
		if (
			cached &&
			cached.rawHash === rawHash &&
			cached.packageId === state.current.id &&
			cached.expectedHash === state.current.sha256 &&
			cached.page === state.current.page
		) {
			return cached.createdAt >= receiverStartedAt ? cached.packet : undefined;
		}
		evictPath(path);
		let raw: string;
		try {
			raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch (error: unknown) {
			throw new Error('Active checkpoint package contains invalid UTF-8.', { cause: error });
		}
		const packet = parseCheckpointPackage(raw);
		validateCheckpointPackage(packet, name);
		const createdAt = Date.parse(packet.createdAt);
		if (
			packet.owner !== name ||
			packet.id !== state.current.id ||
			checkpointHash(packet) !== state.current.sha256 ||
			state.current.page > packet.pages.length ||
			!Number.isFinite(createdAt)
		)
			throw new Error('Active checkpoint package is invalid.');
		// A caller cannot turn a cached validated source bound into a later one.
		freezeValue(packet);
		cachedPackages.set(path, {
			rawHash,
			packageId: state.current.id,
			expectedHash: state.current.sha256,
			page: state.current.page,
			createdAt,
			packet,
		});
		// A restarted receiver must surface retained work rather than inheriting a stuck drain flag.
		return createdAt >= receiverStartedAt ? packet : undefined;
	} catch (error: unknown) {
		evictPath(path);
		throw error;
	}
}

export async function wakeRoomReadThrough(name: string): Promise<number> {
	ownMailbox(name);
	return roomCursor((await optionalText(localCursorPath(name))) ?? '0');
}
