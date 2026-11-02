import { scanLocalEvents } from './local-room.ts';
import { atomicWrite, optionalText } from './mail-files.ts';
import { teamWindowRuntime } from './team-startup.ts';
import { readTeamStartup } from './team-startup.ts';

function cursorPath(): string {
	return teamWindowRuntime('mention-cursor.txt');
}

export async function initialMentionCursor(): Promise<number> {
	const stored = await optionalText(cursorPath());
	if (stored !== undefined) {
		const cursor = Number(stored);
		if (!/^\d+$/.test(stored) || !Number.isSafeInteger(cursor) || cursor < 0)
			throw new Error('Invalid team mention cursor.');
		const { through } = await scanLocalEvents(() => undefined);
		if (cursor > through) throw new Error('Team mention cursor exceeds room history.');
		return cursor;
	}
	const previousStart = await readTeamStartup();
	const startedAt = previousStart ? Date.parse(previousStart) : Infinity;
	let cursor = 0;
	await scanLocalEvents((event) => {
		if (!previousStart || Date.parse(event.at) <= startedAt) cursor = event.id;
	});
	return cursor;
}

export async function saveMentionCursor(cursor: number): Promise<void> {
	if (!Number.isSafeInteger(cursor) || cursor < 0)
		throw new Error('Invalid team mention cursor.');
	await atomicWrite(cursorPath(), String(cursor));
}
