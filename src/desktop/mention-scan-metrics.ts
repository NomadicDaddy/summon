import { atomicWrite } from '../mail-files.ts';

export type MentionScanStage =
	| 'hibernation'
	| 'communication'
	| 'schedules'
	| 'rest'
	| 'recovery'
	| 'events'
	| 'settings'
	| 'wake'
	| 'cursor'
	| 'flush';

export type MentionScanDiagnostic =
	| {
			kind: 'scan';
			at: string;
			durationMs: number;
			stagesMs: Partial<Record<MentionScanStage, number>>;
			skippedTicks: number;
			outcome: 'complete' | 'paused' | 'failed';
	  }
	| {
			kind: 'overlap';
			at: string;
			activeStage: MentionScanStage | null;
			elapsedMs: number;
			skippedTicks: number;
	  };

const MAX_RECORDS = 64;
const NORMAL_WRITE_MS = 30_000;
const URGENT_WRITE_MS = 1_000;

/** Keep a bounded, content-free timing trail outside the scan's awaited path. */
export function createMentionScanRecorder(
	path: string,
	onError: (error: unknown) => void,
	write: typeof atomicWrite = atomicWrite,
): { record: (diagnostic: MentionScanDiagnostic) => void; flush: () => Promise<void> } {
	const records: MentionScanDiagnostic[] = [];
	let overlapTotal = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let scheduledDelay = NORMAL_WRITE_MS;
	let pending = Promise.resolve();
	const flush = (): Promise<void> => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		scheduledDelay = NORMAL_WRITE_MS;
		const text = `${JSON.stringify({ version: 1, overlapTotal, records })}\n`;
		pending = pending.then(() => write(path, text)).catch(onError);
		return pending;
	};
	const schedule = (delay: number): void => {
		if (timer && delay >= scheduledDelay) return;
		if (timer) clearTimeout(timer);
		scheduledDelay = delay;
		timer = setTimeout(() => void flush(), delay);
	};
	return {
		record: (diagnostic) => {
			if (diagnostic.kind === 'overlap') overlapTotal++;
			const last = records.at(-1);
			if (diagnostic.kind === 'overlap' && last?.kind === 'overlap')
				records[records.length - 1] = diagnostic;
			else records.push(diagnostic);
			if (records.length > MAX_RECORDS) records.shift();
			schedule(
				diagnostic.kind === 'overlap' || diagnostic.durationMs >= 2_000
					? URGENT_WRITE_MS
					: NORMAL_WRITE_MS,
			);
		},
		flush,
	};
}
