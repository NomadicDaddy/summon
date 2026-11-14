import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { communicationSend } from './communication-gate.ts';
import { appendLocalEvent } from './local-room.ts';
import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import { storageRoot } from './store.ts';

/**
 * The operator's Away From Keyboard state for one team. It is awareness only: it never gates
 * delivery, approvals, sessions or any teammate state. Teammates read it; only the operator's Team
 * Window writes it. Only the state, its timestamps and the category of what changed it are kept,
 * never what was typed.
 */
export const AWAY_CAUSES = [
	'button',
	'shortcut',
	'teammate-terminal',
	'operator-shell',
	'room-draft',
	'room-send',
	'control-answer',
	'notepad',
	'search',
	'maintenance',
] as const;
export type AwayCause = (typeof AWAY_CAUSES)[number];
/** Causes that are the operator's own input, each of which clears Away and never sets it. */
export type InputCause = Exclude<AwayCause, 'button' | 'shortcut'>;

export type OperatorAwayView =
	{ state: 'here' } | { state: 'away'; since: string } | { state: 'unavailable'; error: string };

export interface AwayTransition {
	changed: boolean;
	view: OperatorAwayView;
	/** Set when the state changed but its Room line could not be posted. */
	roomError?: string;
}

const storedSchema = z
	.strictObject({
		version: z.literal(1),
		state: z.enum(['away', 'here']),
		since: z.iso.datetime().optional(),
		changedAt: z.iso.datetime(),
		cause: z.enum(AWAY_CAUSES),
	})
	.refine((value) => (value.state === 'away') === (value.since !== undefined), {
		message: 'Away needs its start time, and Here has none.',
	});
type Stored = z.infer<typeof storedSchema>;

export function operatorAwayPath(): string {
	return join(storageRoot(), 'settings', 'operator-away.json');
}

function viewOf(stored: Stored): OperatorAwayView {
	return stored.state === 'away' && stored.since
		? { state: 'away', since: stored.since }
		: { state: 'here' };
}

/**
 * Why the state is unavailable, as a fixed sentence. Teammates read it, so it never carries the
 * parser's message, which can quote the file's own bytes (Roger #48243).
 */
const UNAVAILABLE = {
	unreadable: 'The Away state file could not be read.',
	'not-json': 'The Away state file is not valid JSON.',
	'not-a-record': 'The Away state file is not a valid Away record.',
} as const;
type Unavailable = keyof typeof UNAVAILABLE;

type Loaded =
	| { kind: 'missing' }
	| { kind: 'valid'; stored: Stored }
	| { kind: 'invalid'; reason: Unavailable };

async function load(): Promise<Loaded> {
	let raw: string | undefined;
	try {
		raw = await optionalText(operatorAwayPath());
	} catch {
		return { kind: 'invalid', reason: 'unreadable' };
	}
	if (raw === undefined) return { kind: 'missing' };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return { kind: 'invalid', reason: 'not-json' };
	}
	const stored = storedSchema.safeParse(parsed);
	return stored.success
		? { kind: 'valid', stored: stored.data }
		: { kind: 'invalid', reason: 'not-a-record' };
}

function loadedView(loaded: Loaded): OperatorAwayView {
	if (loaded.kind === 'missing') return { state: 'here' };
	if (loaded.kind === 'invalid')
		return { state: 'unavailable', error: UNAVAILABLE[loaded.reason] };
	return viewOf(loaded.stored);
}

function isInputCause(cause: AwayCause): cause is InputCause {
	return cause !== 'button' && cause !== 'shortcut';
}

/** For the masthead, current-requests and startup context. Never writes, never clears. */
export async function readOperatorAway(): Promise<OperatorAwayView> {
	return loadedView(await load());
}

/** Posted by Summon, not as the operator, so the line never reads as the operator's own words. */
const AWAY_ROOM_SENDER = { kind: 'cli', id: 'Summon' } as const;
export function awayRoomText(away: boolean): string {
	return away
		? 'Away: the operator marked themselves away from the keyboard.'
		: 'Away cleared: the operator is back at the keyboard.';
}

/**
 * Sets Away or Here. The Away control sets either; operator input only clears, and only a
 * confirmed Away: it never writes over Here or an unavailable file. The Team Window runs every
 * change in arrival order, so an input clears exactly the Aways set before it. An unchanged state
 * writes nothing and posts nothing. A failed write throws before any Room line, so a transition is
 * reported only once it is stored.
 */
export async function setOperatorAway(away: boolean, cause: AwayCause): Promise<AwayTransition> {
	operatorOnly();
	if (typeof away !== 'boolean' || !AWAY_CAUSES.includes(cause))
		throw new Error('Invalid Away change.');
	if (away && isInputCause(cause)) throw new Error('Only the Away control sets Away.');
	const path = operatorAwayPath();
	return locked(`${path}.lock`, async () => {
		const loaded = await load();
		const current = loadedView(loaded);
		if (isInputCause(cause) && current.state !== 'away')
			return { changed: false, view: current };
		if ((current.state === 'away') === away && current.state !== 'unavailable')
			return { changed: false, view: current };
		if (loaded.kind === 'invalid') {
			// A file that can't be read can't be kept aside, so it is never replaced (Roger #48243).
			if (loaded.reason === 'unreadable')
				throw new Error(`${UNAVAILABLE.unreadable} Away was not changed.`);
			// Keep the bad bytes beside the file before an explicit change replaces them.
			await copyFile(path, `${path}.unreadable-${Date.now()}`);
		}
		const changedAt = new Date().toISOString();
		const stored: Stored = away
			? { version: 1, state: 'away', since: changedAt, changedAt, cause }
			: { version: 1, state: 'here', changedAt, cause };
		await atomicWrite(path, JSON.stringify(stored));
		const view = viewOf(stored);
		const wasAway = current.state === 'away';
		if (wasAway === away) return { changed: true, view };
		try {
			await communicationSend('send the Room post', () =>
				appendLocalEvent({
					sender: { ...AWAY_ROOM_SENDER },
					text: awayRoomText(away),
					replyTo: null,
					source: 'local',
				}),
			);
			return { changed: true, view };
		} catch (error) {
			return {
				changed: true,
				view,
				roomError: error instanceof Error ? error.message : String(error),
			};
		}
	});
}
