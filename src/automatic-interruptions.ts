import type { LocalEvent } from './local-room.ts';

import { headDownActive, headDownPath, readHeadDown } from './head-down-model.ts';
import { locked } from './mail-files.ts';
import { operatorViewing } from './operator-view.ts';

/** Neither pause consumes unread messages; senders retain them for catch-up. */
export async function automaticInterruptionsPaused(name: string): Promise<boolean> {
	return (await operatorViewing(name)) || (await headDownActive(name));
}

/** A peer mention is not steering authority; only the durable authorized action qualifies. */
export async function humanOrHeadDownSteering(event: LocalEvent, name: string): Promise<boolean> {
	if (['user', 'cli'].includes(event.sender.kind)) return true;
	return locked(
		`${headDownPath(name)}.lock`,
		async () => (await readHeadDown(name))?.steeringId === event.id,
	);
}
