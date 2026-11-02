import type { CheckpointPackage } from './checkpoint-package-model.ts';
import type { WakeTarget } from './wake-part.ts';

import { parseCheckpointState } from './checkpoint-package-model.ts';
import { checkpointStatePath } from './checkpoint-package-store.ts';
import { locked, optionalText } from './mail-files.ts';
import { activeWakeReadBoundary } from './wake-read-boundary.ts';

function contains(packet: CheckpointPackage, target: WakeTarget): boolean {
	if (target.source === 'readiness') return false;
	if (target.source === 'room')
		return (
			target.through > packet.sources.room.from &&
			target.through <= packet.sources.room.through
		);
	if (target.source === 'telegram')
		return (
			packet.sources.telegram?.key === target.key &&
			target.through > packet.sources.telegram.from &&
			target.through <= packet.sources.telegram.through
		);
	if (target.source === 'mail')
		return target.ids.every((id) =>
			packet.items.some((item) => item.source === 'mail' && item.id === id),
		);
	return target.ids.every((key) => {
		const [, id, hash] = key.split(':');
		return !!id && packet.sources.holds[id] === hash;
	});
}

export async function responsePackageProgress(name: string) {
	return locked(`${checkpointStatePath(name)}.lock`, async () => {
		const packet = await activeWakeReadBoundary(name, 0);
		const state = parseCheckpointState(await optionalText(checkpointStatePath(name)));
		return (target: WakeTarget) =>
			packet && state.current?.id === packet.id && contains(packet, target)
				? { packageId: packet.id, page: state.current.page }
				: undefined;
	});
}
