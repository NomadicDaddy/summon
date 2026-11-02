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
import { optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { localCursorPath, roomCursor } from './room-cursor.ts';

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
	const state = parseCheckpointState(await optionalText(checkpointStatePath(name)));
	if (!state.current) return undefined;
	const raw = await optionalText(checkpointPackagePath(name));
	if (!raw) throw new Error('Active checkpoint package is missing.');
	const packet = parseCheckpointPackage(raw);
	validateCheckpointPackage(packet, name);
	if (
		packet.owner !== name ||
		packet.id !== state.current.id ||
		checkpointHash(packet) !== state.current.sha256 ||
		state.current.page > packet.pages.length ||
		!Number.isFinite(Date.parse(packet.createdAt))
	)
		throw new Error('Active checkpoint package is invalid.');
	// A restarted receiver must surface retained work rather than inheriting a stuck drain flag.
	return Date.parse(packet.createdAt) >= receiverStartedAt ? packet : undefined;
}

export async function wakeRoomReadThrough(name: string): Promise<number> {
	ownMailbox(name);
	return roomCursor((await optionalText(localCursorPath(name))) ?? '0');
}
