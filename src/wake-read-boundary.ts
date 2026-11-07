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
	path: string;
	receiverStartedAt: number;
	rawHash: string;
	packageId: string;
	expectedHash: string;
	page: number;
	packet: CheckpointPackage;
}

const MAX_CACHED_PACKAGES = 4;
const cachedPackages = new Map<string, CachedPackage>();

function evictPath(path: string): void {
	for (const [key, entry] of cachedPackages) if (entry.path === path) cachedPackages.delete(key);
}

function remember(key: string, entry: CachedPackage): void {
	cachedPackages.delete(key);
	cachedPackages.set(key, entry);
	while (cachedPackages.size > MAX_CACHED_PACKAGES) {
		const oldest = cachedPackages.keys().next().value;
		if (oldest === undefined) break;
		cachedPackages.delete(oldest);
	}
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
		const key = `${path}\0${receiverStartedAt}`;
		for (const [entryKey, entry] of cachedPackages) {
			if (
				entry.path === path &&
				(entry.rawHash !== rawHash ||
					entry.packageId !== state.current.id ||
					entry.expectedHash !== state.current.sha256 ||
					entry.page !== state.current.page)
			)
				cachedPackages.delete(entryKey);
		}
		const cached = cachedPackages.get(key);
		if (cached) {
			remember(key, cached);
			return cached.packet;
		}
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
		// A restarted receiver must surface retained work rather than inheriting a stuck drain flag.
		if (createdAt < receiverStartedAt) return undefined;
		// A caller cannot turn a cached validated source bound into a later one.
		freezeValue(packet);
		remember(key, {
			path,
			receiverStartedAt,
			rawHash,
			packageId: state.current.id,
			expectedHash: state.current.sha256,
			page: state.current.page,
			packet,
		});
		return packet;
	} catch (error: unknown) {
		evictPath(path);
		throw error;
	}
}

export async function wakeRoomReadThrough(name: string): Promise<number> {
	ownMailbox(name);
	return roomCursor((await optionalText(localCursorPath(name))) ?? '0');
}
