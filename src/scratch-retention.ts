import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { storageRoot } from './store.ts';

/** Phillip #17706: anything in scratch older than 30 days goes at the operator's startup. */
export const SCRATCH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SAMPLE_LIMIT = 20;
const FILETIME_EPOCH_MS = 11_644_473_600_000n;
const START_LIMIT_MS = 30_000;
const RUN_LIMIT_MS = 300_000;
const helperPath = fileURLToPath(new URL('../scripts/scratch-expiry.ps1', import.meta.url));

export interface ExpiryReport {
	cutoff: string;
	removedFiles: number;
	removedDirectories: number;
	/** Gone before Summon got to them: not counted as removed. */
	disappeared: number;
	skipped: number;
	skippedSample: { path: string; reason: string }[];
	/** Set when the whole run was refused before anything was removed. */
	refused?: string;
	/**
	 * Set when the helper stopped after it was told to start: removals may have happened, and the
	 * counts above are not final.
	 */
	incomplete?: string;
}

/**
 * Test seams. Each runs while the helper waits at that point with its handles held: before a
 * folder is listed, before an entry's exclusive open, and after every check just before the
 * delete is set. `helper` replaces the worker script, and the limits shorten its timers.
 */
export interface ExpiryOptions {
	beforeList?: (path: string) => Promise<void> | void;
	beforeRemove?: (path: string) => Promise<void> | void;
	beforeDispose?: (path: string) => Promise<void> | void;
	helper?: string;
	startLimitMs?: number;
	runLimitMs?: number;
}

const readySchema = z.object({
	ready: z.literal(true),
	state: z.enum(['present', 'absent', 'redirected']),
});
const pauseSchema = z.object({
	pause: z.enum(['list', 'remove', 'dispose']),
	path: z.string().min(1),
});
const count = z.number().int().nonnegative();
const doneSchema = z.object({
	report: z.object({
		removedFiles: count,
		removedDirectories: count,
		disappeared: count,
		skipped: count,
		sample: z.array(z.object({ path: z.string(), reason: z.string() })).max(SAMPLE_LIMIT),
	}),
});

function lineReader(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	const decoder = new TextDecoder('utf-8', { fatal: true });
	let buffered = '';
	return {
		async next(): Promise<unknown> {
			for (;;) {
				const end = buffered.indexOf('\n');
				if (end >= 0) {
					const line = buffered.slice(0, end).trim();
					buffered = buffered.slice(end + 1);
					return JSON.parse(line) as unknown;
				}
				if (buffered.length > 1_000_000) throw new Error('Oversized expiry response.');
				const chunk = await reader.read();
				if (chunk.done) return undefined;
				buffered += decoder.decode(chunk.value, { stream: true });
			}
		},
		release: () => {
			reader.releaseLock();
		},
	};
}

/**
 * Remove regular files in the store's scratch tree last written strictly before `startedAt - 30
 * days`, then folders that were already older than the cutoff and are empty once their contents
 * are handled. Windows only, in one pwsh worker (scripts/scratch-expiry.cs) that holds scratch's
 * whole ancestor chain and every folder it lists, never follows a reparse point, and deletes only
 * through an exclusive handle whose identity, size and times still match. A handle another process
 * holds for metadata only does not block removal (see README). Never removes the scratch root, a
 * member's home or shared. Other platforms are refused, removing nothing.
 */
export async function expireScratch(
	store: string,
	startedAt: number,
	options: ExpiryOptions = {},
): Promise<ExpiryReport> {
	const cutoff = startedAt - SCRATCH_MAX_AGE_MS;
	const root = resolve(store, 'scratch');
	const report: ExpiryReport = {
		cutoff: new Date(cutoff).toISOString(),
		removedFiles: 0,
		removedDirectories: 0,
		disappeared: 0,
		skipped: 0,
		skippedSample: [],
	};
	if (process.platform !== 'win32')
		return { ...report, refused: "scratch expiry isn't supported on this platform" };
	const {
		helper = helperPath,
		startLimitMs = START_LIMIT_MS,
		runLimitMs = RUN_LIMIT_MS,
		...hooks
	} = options;
	let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
	try {
		child = Bun.spawn({
			cmd: ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper],
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
		});
	} catch {
		return { ...report, refused: 'the scratch expiry helper could not start (pwsh)' };
	}
	const stderr = new Response(child.stderr).text();
	const lines = lineReader(child.stdout);
	let started = false;
	// Only this worker, never a session, provider or other process.
	const timer = setTimeout(() => child.kill(), startLimitMs);
	// Ends and reaps the worker first: a live worker never closes stderr, so reading it would wait
	// for as long as the worker chose to.
	const stopped = async (): Promise<string> => {
		if (child.exitCode === null) child.kill();
		await child.exited;
		return (await stderr).trim().split('\n')[0]?.slice(0, 200) || 'no detail';
	};
	try {
		const request = JSON.stringify({
			root,
			cutoff: ((BigInt(cutoff) + FILETIME_EPOCH_MS) * 10_000n).toString(),
			pause: Object.values(hooks).some(Boolean),
		});
		// ASCII only, both ways: pwsh reads and writes the console code page, not UTF-8.
		// JSON.stringify already escaped control characters, so this catches only non-ASCII.
		const ascii = request.replace(
			/[^ -~]/g,
			(unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`,
		);
		await child.stdin.write(`${ascii}\n`);
		await child.stdin.flush();
		const ready = readySchema.safeParse(await lines.next());
		if (!ready.success) {
			return {
				...report,
				refused: `the scratch expiry helper could not start (${await stopped()})`,
			};
		}
		if (ready.data.state === 'redirected')
			return {
				...report,
				refused: 'the scratch folder or a folder above it is redirected or is not a folder',
			};
		if (ready.data.state === 'absent') return report;
		clearTimeout(timer);
		const runTimer = setTimeout(() => child.kill(), runLimitMs);
		try {
			// The worker deletes nothing before this line. From here on a failure is incomplete.
			started = true;
			await child.stdin.write('start\n');
			await child.stdin.flush();
			for (;;) {
				const line = await lines.next();
				const pause = pauseSchema.safeParse(line);
				if (pause.success) {
					const hook = {
						list: hooks.beforeList,
						remove: hooks.beforeRemove,
						dispose: hooks.beforeDispose,
					}[pause.data.pause];
					await hook?.(join(root, pause.data.path));
					await child.stdin.write('continue\n');
					await child.stdin.flush();
					continue;
				}
				const done = doneSchema.safeParse(line);
				if (!done.success || (await child.exited) !== 0) break;
				const { sample, ...counts } = done.data.report;
				return { ...report, ...counts, skippedSample: sample };
			}
		} finally {
			clearTimeout(runTimer);
		}
		return {
			...report,
			incomplete: `the scratch expiry helper stopped before reporting (${await stopped()})`,
		};
	} catch {
		const detail = await stopped();
		return started
			? { ...report, incomplete: `the scratch expiry helper stopped (${detail})` }
			: { ...report, refused: `the scratch expiry helper could not start (${detail})` };
	} finally {
		clearTimeout(timer);
		try {
			await child.stdin.end();
		} catch {
			// Already closed by the worker's exit.
		}
		if (child.exitCode === null) child.kill();
		await child.exited;
		await stderr;
		lines.release();
	}
}

/** One console line, with bounded and escaped relative paths and no file contents. */
export function expiryLine(report: ExpiryReport): string {
	if (report.refused) return `Scratch expiry skipped: ${report.refused}. Nothing was removed.`;
	if (report.incomplete)
		return `Scratch expiry stopped before it finished: ${report.incomplete}. Some files may have been removed; the final counts are unknown.`;
	const parts = [
		`Scratch expiry: removed ${report.removedFiles} files and ${report.removedDirectories} folders last changed before ${report.cutoff}`,
	];
	if (report.disappeared) parts.push(`${report.disappeared} were already gone`);
	if (report.skipped) {
		const sample = report.skippedSample
			.map((item) => `${JSON.stringify(item.path)} (${item.reason})`)
			.join(', ');
		parts.push(
			`skipped ${report.skipped}: ${sample}${report.skipped > SAMPLE_LIMIT ? ', ...' : ''}`,
		);
	}
	return `${parts.join('; ')}.`;
}

/** The operator start paths only; a teammate's CLI call never purges other members' scratch. */
export async function operatorScratchExpiry(startedAt = Date.now()): Promise<void> {
	if (process.env.SUMMON_AGENT) return;
	console.log(expiryLine(await expireScratch(storageRoot(), startedAt)));
}
