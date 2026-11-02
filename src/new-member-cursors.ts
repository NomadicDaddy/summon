import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { checkpointConfig } from './checkpoint-package-capture.ts';
import { cachedLocalEvents, type LocalEvent } from './local-room.ts';
import { atomicWrite, locked, missing } from './mail-files.ts';
import { runtimePath } from './mail-session.ts';
import { localCursorPath } from './room-cursor.ts';
import { storageRoot } from './storage-root.ts';
import { roomCursorPath } from './telegram-live.ts';
import { roomEvents } from './telegram-room.ts';

/** Checkpoint and catch-up state a new member must never inherit from an earlier one. */
const retainedState = [
	'checkpoint.json',
	'checkpoint-package.json',
	'checkpoint-catch-up.json',
	'checkpoint-skips',
];

async function present(path: string): Promise<boolean> {
	try {
		if ((await lstat(path)).isSymbolicLink())
			throw new Error(`Refusing to write through redirected member storage: ${path}`);
		return true;
	} catch (error: unknown) {
		if (missing(error)) return false;
		throw error;
	}
}

/**
 * A name registered again may find runtime state from the member who held it before. Cursors are
 * replaced by a fresh start below, and a stale session lock is what a normal removal leaves behind.
 * A running session needs no check here: every creator (the CLI, the PM command, clone and a Team
 * Maintenance add) holds the name's session lock while it creates the record, which refuses a live
 * session. A frozen checkpoint or catch-up plan is refused rather than inherited or discarded, so
 * its package, mail and holds stay exactly as they were.
 */
async function assertFreshRuntime(name: string): Promise<void> {
	const runtime = runtimePath(name);
	await present(join(storageRoot(), 'runtime'));
	if (!(await present(runtime))) return;
	for (const entry of retainedState)
		if (await present(join(runtime, entry)))
			throw new Error(
				`Checkpoint state from an earlier ${name} remains in ${runtime}. Move it aside, then register again.`,
			);
}

/**
 * A new registration is a new member, so a cursor left behind under its name, by a hand-deleted
 * registration or a failed earlier attempt, is replaced by a fresh start rather than kept.
 */
async function seedCursor(path: string, through: number): Promise<void> {
	await present(path);
	await locked(`${path}.lock`, () => atomicWrite(path, String(through)));
}

/**
 * The cursor just before the first Room post at or after local midnight, in this machine's time
 * zone, where the team works, so that post is read rather than skipped. A later post stamped before
 * midnight never moves it past an earlier one from today. When nothing has been posted today it is
 * the latest post, and an empty Room gives 0. A post whose time cannot be read refuses the
 * registration rather than guessing where today begins.
 */
function lastPostBeforeToday(events: readonly LocalEvent[]): number {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const times = events.map((event) => Date.parse(event.at));
	const unreadable = events.find((_, index) => Number.isNaN(times[index]));
	if (unreadable)
		throw new Error(
			`Room post #${String(unreadable.id)} has an unreadable time; nothing was registered.`,
		);
	const first = times.findIndex((time) => time >= today.getTime());
	if (first === -1) return events.at(-1)?.id ?? 0;
	return events[first - 1]?.id ?? 0;
}

/**
 * A newly registered member starts its Room cursor at the start of today and its Telegram cursor at
 * the present, so its first checkpoint, wake and current-requests view hold today's Room and what
 * arrives after it joined, never the whole history. Every reader treats a missing cursor as 0,
 * which replayed all of it. Telegram events carry no time, and today's Telegram posts are already
 * mirrored into the Room, so an earlier Telegram start would only repeat them. Each head is
 * captured once, and anything posted after it stays pending. Earlier posts stay readable through
 * --room read, show and search, and checkpoint catch-up.
 */
export async function seedNewMemberCursors(name: string): Promise<void> {
	await assertFreshRuntime(name);
	await seedCursor(localCursorPath(name), lastPostBeforeToday(await cachedLocalEvents()));
	const config = await checkpointConfig(true);
	if (config)
		await seedCursor(
			roomCursorPath(config, name),
			(await roomEvents(config)).at(-1)?.sequence ?? 0,
		);
}
