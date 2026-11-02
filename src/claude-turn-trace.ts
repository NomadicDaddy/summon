import { appendFile, lstat } from 'node:fs/promises';

import { missing } from './mail-files.ts';

type Phase = 'busy' | 'idle' | 'unknown';
interface Snapshot {
	phase: Phase;
	turn: string | null;
	attached: boolean;
	epoch: number;
	draft: boolean;
	compactions: number;
}
type Source =
	| 'observe'
	| 'initialize'
	| 'attach-observer'
	| 'invalidate'
	| 'human-submit'
	| 'notice-reserve'
	| 'notice-restore'
	| 'notice-release'
	| 'release-spent';

/** One line per write to a Claude turn record, or per observation that left it unchanged. */
interface ClaudeTurnTraceEntry {
	at: string;
	source: Source;
	kind?: string;
	epoch?: number;
	sequence?: number;
	turn?: string | null;
	completed?: boolean;
	draft?: boolean;
	before: Snapshot | null;
	after: Snapshot | null;
	verdict: string;
	/** Lines this process failed or refused to write since its last written line. */
	missed?: number;
}

/** About 4,000 lines; one launch's trace stops here with a final line saying so. */
export const claudeTurnTraceCap = 1024 * 1024;
const capMargin = 2048;
const capVerdict = `trace cap of ${claudeTurnTraceCap} bytes reached; later observations are not recorded`;
const missedWrites = new Map<string, number>();

/**
 * The turn record is overwritten in place, so without this log a gate stuck at busy cannot be
 * traced to the event that left it there. Metadata only: no prompt, draft or transcript text.
 * Append-only and bounded; the caller holds the record lock. A failed or refused write never
 * blocks the observation it describes, and the next written line counts what was missed.
 */
async function traceClaudeTurn(recordPath: string, entry: ClaudeTurnTraceEntry): Promise<void> {
	const path = `${recordPath}.trace`;
	const miss = (): void => {
		missedWrites.set(path, (missedWrites.get(path) ?? 0) + 1);
	};
	try {
		const info = await lstat(path).catch((error: unknown) => {
			if (missing(error)) return undefined;
			throw error;
		});
		if (info && (!info.isFile() || info.isSymbolicLink())) {
			miss();
			return;
		}
		const size = info?.size ?? 0;
		const missed = missedWrites.get(path) ?? 0;
		let line = JSON.stringify(missed ? { ...entry, missed } : entry);
		if (size + line.length + 1 > claudeTurnTraceCap - capMargin) {
			// Near the cap: one final line says the trace stopped, and nothing follows it.
			const tail = await Bun.file(path)
				.slice(Math.max(0, size - capMargin))
				.text();
			if (tail.includes(capVerdict)) return;
			line = JSON.stringify({
				at: entry.at,
				source: entry.source,
				before: null,
				after: null,
				verdict: capVerdict,
				...(missed ? { missed } : {}),
			});
		}
		await appendFile(path, `${line}\n`, { encoding: 'utf8', flag: 'a' });
		missedWrites.delete(path);
	} catch {
		miss();
	}
}

function snapshot(state: Snapshot | undefined): Snapshot | null {
	if (!state) return null;
	const { attached, compactions, draft, epoch, phase, turn } = state;
	return { attached, compactions, draft, epoch, phase, turn };
}

/** What the reducer made of an ordered event, named so a stuck gate reads at a glance. */
function verdictFor(kind: string, turn: string | null, before: Snapshot, after: Snapshot): string {
	if (
		after.phase !== before.phase ||
		after.turn !== before.turn ||
		after.attached !== before.attached ||
		after.compactions !== before.compactions
	)
		return 'applied';
	if (kind === 'complete' && turn !== before.turn)
		return 'ignored: completion for a turn the record does not hold';
	if (kind === 'idle')
		return 'ignored: idle needs phase unknown, no turn, no draft and no compaction';
	if (!before.attached) return 'ignored: observer not attached';
	return 'no phase change';
}

/** A native hook observation and what the reducer made of it. */
export function traceEvent(
	recordPath: string,
	event: {
		kind: string;
		epoch: number;
		sequence: number;
		turn: string | null;
		completed: boolean;
		draft: boolean;
	},
	before: Snapshot,
	after: Snapshot,
	verdict: 'ordered' | 'gap' | `ignored: ${string}`,
): Promise<void> {
	return traceClaudeTurn(recordPath, {
		at: new Date().toISOString(),
		source: 'observe',
		kind: event.kind,
		epoch: event.epoch,
		sequence: event.sequence,
		turn: event.turn,
		completed: event.completed,
		draft: event.draft,
		before: snapshot(before),
		after: snapshot(after),
		verdict:
			verdict === 'ordered' ? verdictFor(event.kind, event.turn, before, after) : verdict,
	});
}

/** A write Summon makes itself: a launch, an attachment, an invalidation, an Enter or a notice. */
export function traceSwap(
	recordPath: string,
	source: Exclude<Source, 'observe'>,
	before: Snapshot | undefined,
	after: Snapshot,
	verdict: string,
): Promise<void> {
	return traceClaudeTurn(recordPath, {
		at: new Date().toISOString(),
		source,
		before: snapshot(before),
		after: snapshot(after),
		verdict,
	});
}
