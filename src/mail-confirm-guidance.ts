/**
 * The recovery a confirmation refusal names when a request has no read coverage yet
 * (mail-confirm-receipt-guidance). Coverage is recorded in three places only: when a checkpoint
 * page that completes the body is acknowledged, when receive returns the body whole, and when
 * read-self's contiguous window reaches the last byte. So an unread request has one honest way
 * forward, and this says which, from the caller's own state.
 *
 * Read-only and advisory. It reads the caller's checkpoint state and frozen package directly,
 * never through loadCheckpointPackage (which publishes a current package when none is set),
 * writes nothing, takes no lock and starts nothing. A state that is missing, malformed, foreign,
 * out of range or changes while it is read gives no page hint, and the read-self route stands.
 * It never prints a receipt for a page the caller has not been delivered, never quotes persisted
 * content, and names only the caller's own ids.
 */
import type { CheckpointPackage, CheckpointState } from './checkpoint-package-model.ts';

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

/** The window read-self is asked for in each hint, matching its documented bound. */
const READ_LIMIT = 32768;

interface Frozen {
	packet: CheckpointPackage;
	state: CheckpointState & { current: NonNullable<CheckpointState['current']> };
}

/** Reads a state file as text, or undefined when it is absent. */
export type ReadText = (path: string) => Promise<string | undefined>;

/** The caller's current frozen package, only when every check holds; otherwise undefined. */
async function frozenPackage(name: string, read: ReadText): Promise<Frozen | undefined> {
	try {
		const rawState = await read(checkpointStatePath(name));
		if (rawState === undefined) return undefined;
		const state = parseCheckpointState(rawState);
		const current = state.current;
		if (current === undefined) return undefined;
		const rawPackage = await read(checkpointPackagePath(name));
		if (rawPackage === undefined) return undefined;
		const packet = parseCheckpointPackage(rawPackage);
		validateCheckpointPackage(packet, name);
		if (packet.id !== current.id || checkpointHash(packet) !== current.sha256) return undefined;
		if (current.page > packet.pages.length) return undefined;
		// A checkpoint or catch-up that moved while the package was read makes the hint stale.
		if ((await read(checkpointStatePath(name))) !== rawState) return undefined;
		return { packet, state: { ...state, current } };
	} catch {
		return undefined;
	}
}

/** The page-receipt route, when the body completes on a page not yet acknowledged. */
function pageHint(frozen: Frozen, id: string): string | undefined {
	const { packet, state } = frozen;
	const current = state.current.page;
	// The final-receipt phase has no page left: nothing there carries or completes a body.
	if (current >= packet.pages.length) return undefined;
	const completes = packet.pages.findIndex(
		(page, index) => index >= current && page.completeMail.some((mail) => mail.id === id),
	);
	if (completes < 0) return undefined;
	const item = packet.items.find((entry) => entry.source === 'mail' && entry.id === id);
	const total = packet.pages.length;
	const span =
		item !== undefined && item.firstPage < item.lastPage
			? `Its body is spread over checkpoint pages ${String(item.firstPage + 1)} to ${String(item.lastPage + 1)} of ${String(total)} and is`
			: `Its body is on checkpoint page ${String(completes + 1)} of ${String(total)} and is`;
	const recorded = `${span} recorded as read when page ${String(completes + 1)}'s receipt is accepted.`;
	if (completes === current) {
		const receipt = packet.pages[completes]?.receipt ?? '';
		return `${recorded} Run summon --checkpoint without a receipt to replay that page, read the whole page, then pass its receipt with summon --checkpoint ${receipt}. Confirm after that.`;
	}
	return `${recorded} Continue summon --checkpoint from page ${String(current + 1)}: read each page whole and pass its receipt in order. Confirm after page ${String(completes + 1)} is accepted.`;
}

/** The byte offset a partial read-self reached, when it is a usable point to continue from. */
function continueAt(offsetText: string | undefined, size: number): number {
	const offset = Number(offsetText);
	return Number.isSafeInteger(offset) && offset > 0 && offset < size ? offset : 0;
}

/**
 * The refusal text for confirming request `id`, which has no read coverage.
 *
 * @param name - The caller, whose own state alone is read.
 * @param id - The request's id.
 * @param size - The request's size in bytes.
 * @param offsetText - The caller's recorded read-self offset for it, if any.
 * @param read - How state files are read; a test can make the state change between reads.
 * @returns One sentence of refusal plus the single recovery that applies.
 */
export async function confirmGuidance(
	name: string,
	id: string,
	size: number,
	offsetText: string | undefined,
	read: ReadText = optionalText,
): Promise<string> {
	const refusal = 'Read the entire request before confirming.';
	const frozen = await frozenPackage(name, read);
	const fromPage = frozen === undefined ? undefined : pageHint(frozen, id);
	if (fromPage !== undefined) return `${refusal} ${fromPage}`;
	const offset = continueAt(offsetText, size);
	if (offset > 0) {
		return `${refusal} A read-self of it stopped at byte ${String(offset)} of ${String(size)}. Continue with summon --mail read-self ${id} --offset ${String(offset)} --limit ${String(READ_LIMIT)}, and keep going from each returned end until its last byte; it is recorded as read then.`;
	}
	return `${refusal} Read it whole first with summon --mail read-self ${id} --offset 0 --limit ${String(READ_LIMIT)}, continuing from each returned end until its last byte (or summon --mail receive when it fits on one page). Confirm after that.`;
}
