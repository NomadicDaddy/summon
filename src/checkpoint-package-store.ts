import { join } from 'node:path';

import type { CheckpointPackage, CheckpointState } from './checkpoint-package-model.ts';

import { captureCheckpoint } from './checkpoint-package-capture.ts';
import { checkpointHash, parseCheckpointPackage } from './checkpoint-package-model.ts';
import { atomicWrite, optionalText } from './mail-files.ts';
import { runtimePath } from './mail-session.ts';

export const checkpointStatePath = (name: string): string =>
	join(runtimePath(name), 'checkpoint.json');
export const checkpointPackagePath = (name: string): string =>
	join(runtimePath(name), 'checkpoint-package.json');

export function validateCheckpointPackage(packet: CheckpointPackage, name: string): void {
	const receipts = [packet.finalReceipt, ...packet.pages.map((page) => page.receipt)];
	if (
		packet.owner !== name ||
		new Set(receipts).size !== receipts.length ||
		packet.sources.room.from > packet.sources.room.through ||
		(packet.sources.telegram &&
			packet.sources.telegram.from > packet.sources.telegram.through) ||
		packet.pages.some((page) => Buffer.byteLength(JSON.stringify(page.payload)) > 30_000) ||
		packet.items.some(
			(item) =>
				item.parts < 1 ||
				item.firstPage > item.lastPage ||
				item.lastPage >= packet.pages.length,
		)
	)
		throw new Error('Invalid frozen checkpoint package. Nothing was acknowledged.');
}

export async function loadCheckpointPackage(
	name: string,
	state: CheckpointState,
): Promise<CheckpointPackage | undefined> {
	const raw = await optionalText(checkpointPackagePath(name));
	if (!raw) {
		if (state.current)
			throw new Error('Frozen checkpoint package is missing. Nothing was acknowledged.');
		return undefined;
	}
	const packet = parseCheckpointPackage(raw);
	validateCheckpointPackage(packet, name);
	if (state.current) {
		if (
			packet.id !== state.current.id ||
			checkpointHash(packet) !== state.current.sha256 ||
			state.current.page > packet.pages.length
		)
			throw new Error('Frozen checkpoint package changed. Nothing was acknowledged.');
		return packet;
	}
	if (state.completedPackage === packet.id || state.supersededPackage === packet.id)
		return undefined;
	state.current = { id: packet.id, sha256: checkpointHash(packet), page: 0 };
	await saveCheckpointState(name, state);
	return packet;
}

export async function newCheckpointPackage(
	name: string,
	state: CheckpointState,
	onTelegramUnavailable: (reason: string) => void = () => {},
): Promise<CheckpointPackage | undefined> {
	const packet = await captureCheckpoint(name, state, onTelegramUnavailable);
	if (!packet.pages.length) return undefined;
	// Never publish a package that the next process cannot load and acknowledge.
	const raw = JSON.stringify(packet);
	try {
		validateCheckpointPackage(parseCheckpointPackage(raw), name);
	} catch {
		throw new Error(
			`Next checkpoint package failed validation before publication. Last acknowledged receipt: ${state.lastAck ?? 'none'}. No new package was saved.`,
		);
	}
	await atomicWrite(checkpointPackagePath(name), raw);
	state.current = { id: packet.id, sha256: checkpointHash(packet), page: 0 };
	await saveCheckpointState(name, state);
	return packet;
}

export async function saveCheckpointState(name: string, state: CheckpointState): Promise<void> {
	await atomicWrite(checkpointStatePath(name), JSON.stringify(state));
}
