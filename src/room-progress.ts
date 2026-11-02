import { localHead } from './local-room.ts';
import { optionalText } from './mail-files.ts';
import { localCursorPath, roomCursor } from './room-cursor.ts';

export interface RoomProgress {
	cursor: number;
	head: number;
	pending: number;
}

/** Acknowledged history only: this is not evidence of attention or completed work. */
export async function roomProgress(name: string): Promise<RoomProgress | undefined> {
	try {
		const cursor = roomCursor((await optionalText(localCursorPath(name))) ?? '0');
		const head = await localHead();
		if (cursor > head) return undefined;
		return { cursor, head, pending: head - cursor };
	} catch {
		// Unavailable room metadata must not remove an otherwise valid teammate from the roster.
		return undefined;
	}
}
