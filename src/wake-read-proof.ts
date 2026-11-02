import { join } from 'node:path';

import type { WakeTarget } from './wake-part.ts';

import { checkpointHash, parseCheckpointState } from './checkpoint-package-model.ts';
import { checkpointStatePath } from './checkpoint-package-store.ts';
import { optionalText } from './mail-files.ts';
import { ownMailbox } from './mail-identity.ts';
import { statePath } from './mail-read.ts';
import { runtimePath } from './mail-session.ts';
import { localCursorPath, roomCursor } from './room-cursor.ts';
import { storageRoot } from './store.ts';
import { telegramConfig } from './telegram-api.ts';
import { roomCursorPath } from './telegram-live.ts';

/** Complete source read coverage only. Neither provider submission nor status inspection is a read. */
export async function wakeTargetRead(
	name: string,
	nonce: string,
	target: WakeTarget,
): Promise<boolean> {
	ownMailbox(name);
	if (target.source === 'readiness')
		return (await optionalText(join(runtimePath(name), `${nonce}.ready`))) === nonce;
	if (target.source === 'room')
		return roomCursor((await optionalText(localCursorPath(name))) ?? '0') >= target.through;
	if (target.source === 'mail')
		return (
			await Promise.all(
				target.ids.map(async (id) => !!(await optionalText(statePath(name, id, 'read')))),
			)
		).every(Boolean);
	if (target.source === 'holds') {
		const state = parseCheckpointState(await optionalText(checkpointStatePath(name)));
		return target.ids.every((key) => {
			const [, id, fingerprint] = key.split(':');
			return !!id && !!fingerprint && state.seenHolds[id] === fingerprint;
		});
	}
	if (!(await optionalText(join(storageRoot(), 'integrations', 'telegram.json')))) return false;
	const config = await telegramConfig();
	return (
		checkpointHash([config.botToken.split(':')[0], config.chatId]) === target.key &&
		roomCursor((await optionalText(roomCursorPath(config, name))) ?? '0') >= target.through
	);
}
