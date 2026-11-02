import { CHECKPOINT_CATCH_UP_HOLD } from './checkpoint-work.ts';
import { scanLocalEvents } from './local-room.ts';
import { optionalText } from './mail-files.ts';
import { localCursorPath, roomCursor } from './room-cursor.ts';

/** A preview never acknowledges skipped history or changes a pending checkpoint receipt. */
export async function currentRoomRequest(name: string): Promise<string> {
	const cursor = roomCursor((await optionalText(localCursorPath(name))) ?? '0');
	let unread = 0;
	let latest: number | undefined;
	await scanLocalEvents((event) => {
		if (event.id <= cursor) return;
		unread++;
		if (event.sender.kind === 'user') latest = event.id;
	});
	// Keep ordinary wakes compact; this escape from old catch-up is only needed for a backlog.
	if (unread <= 100 || latest === undefined) return '';
	return (
		` Latest unread human message: #${latest}. Read it now with ` +
		`supplied command: summon --room read ${latest - 1}. ` +
		'Assess its addressee and scope before acting. This is a read-only preview: do not ' +
		'ack its cursor. Continue with your retained checkpoint receipt, or use the explicit ' +
		'catch-up preview/apply operation for old routine history; never manufacture read coverage. ' +
		CHECKPOINT_CATCH_UP_HOLD
	);
}
