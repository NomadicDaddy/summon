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

function writeErrorKey(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
	const syscall = 'syscall' in error && typeof error.syscall === 'string' ? error.syscall : '';
	return code ? `${code}:${syscall}` : error.name;
}

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
	let lastWriteError: string | null = null;
	const flush = (): Promise<void> => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		scheduledDelay = NORMAL_WRITE_MS;
		const text = `${JSON.stringify({ version: 1, overlapTotal, records })}\n`;
		pending = pending
			.then(() => write(path, text))
			.then(
				() => {
					lastWriteError = null;
				},
				(error: unknown) => {
					const key = writeErrorKey(error);
					if (key === lastWriteError) return;
					lastWriteError = key;
					onError(error);
				},
			);
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
