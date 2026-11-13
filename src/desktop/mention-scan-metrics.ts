import type { RestScanDiagnostic } from './rest.ts';

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
			rest?: RestScanDiagnostic;
			skippedTicks: number;
			outcome: 'complete' | 'paused' | 'failed';
	  }
	| {
			kind: 'overlap';
			at: string;
			activeStage: MentionScanStage | null;
			elapsedMs: number;
			skippedTicks: number;
	  }
	| PaneSwitchDiagnostic;

/**
 * One operator click on a teammate, timed from the renderer: the pane's first paint, the wait
 * before the main process received the select, the full snapshot the select awaited, and the
 * total until that snapshot arrived. Kept in its own ring so scans can't evict it.
 */
export interface PaneSwitchDiagnostic {
	kind: 'switch';
	at: string;
	durationMs: number;
	paintMs: number | null;
	ipcWaitMs: number | null;
	selectMs: number | null;
	outcome: 'complete' | 'failed' | 'superseded';
}

const SWITCH_OUTCOMES: ReadonlySet<string> = new Set(['complete', 'failed', 'superseded']);
// Bounds a reasonable value: an hour, past any real switch, and never negative.
const timingMs = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 3_600_000;

/** The renderer's switch record, accepted only in exactly its own shape and bounds. */
export function paneSwitchDiagnostic(value: unknown): PaneSwitchDiagnostic | null {
	if (typeof value !== 'object' || value === null) return null;
	const record = value as Record<string, unknown>;
	const optional = (field: unknown): field is null | number => field === null || timingMs(field);
	if (
		record.kind !== 'switch' ||
		typeof record.at !== 'string' ||
		Number.isNaN(Date.parse(record.at)) ||
		!timingMs(record.durationMs) ||
		!optional(record.paintMs) ||
		!optional(record.ipcWaitMs) ||
		!optional(record.selectMs) ||
		typeof record.outcome !== 'string' ||
		!SWITCH_OUTCOMES.has(record.outcome)
	)
		return null;
	return {
		kind: 'switch',
		at: record.at,
		durationMs: record.durationMs,
		paintMs: record.paintMs,
		ipcWaitMs: record.ipcWaitMs,
		selectMs: record.selectMs,
		outcome: record.outcome as PaneSwitchDiagnostic['outcome'],
	};
}

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
