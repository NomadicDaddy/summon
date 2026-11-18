import { createHash } from 'node:crypto';
import { z } from 'zod';

import { scheduleDeferral } from './schedule-deferral.ts';

export const scheduleText = z.string().trim().min(1).max(8000);
export const scheduleInput = z
	.object({
		owner: z.string().min(1),
		title: z.string().trim().min(1).max(120),
		everyMinutes: z.number().int().min(1).max(525600),
		prompt: scheduleText,
	})
	.strict();
const schedule = scheduleInput.extend({
	id: z.uuid(),
	enabled: z.boolean(),
	nextDueAt: z.number().int().nonnegative(),
	deferred: scheduleDeferral.optional(),
});
const runFields = {
	id: z.uuid(),
	scheduleId: z.uuid(),
	owner: z.string(),
	title: z.string(),
	dueAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
	status: z.enum(['dispatching', 'delivered', 'uncertain', 'complete', 'failed']),
	result: z.string().max(8000).optional(),
};
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
// A stored run never carries its prompt; strict() refuses one that does.
const storedRun = z.object({ ...runFields, promptSha256: sha256 }).strict();
const storedState = z
	.object({
		version: z.literal(2),
		schedules: z.array(schedule),
		// Exact stored bytes: no trim or other transform, so a prompt hashes back to its key.
		prompts: z.record(sha256, z.string().min(1).max(8000)),
		runs: z.array(storedRun),
		warnedStep: z.number().int().positive().optional(),
	})
	.strict();

export type ScheduledRun = Omit<z.infer<typeof storedRun>, 'promptSha256'> & { prompt: string };
export type Schedule = z.infer<typeof schedule>;
export type StoredState = z.infer<typeof storedState>;
/** What callers see: schedules and hydrated runs, never the prompt store or warning bookkeeping. */
export type PublicScheduleState = { version: 2; schedules: Schedule[]; runs: ScheduledRun[] };
/** Writers' working state inside schedules.ts: the stored map and warning step ride privately. */
export type State = PublicScheduleState & { prompts: Record<string, string>; warnedStep?: number };

/**
 * Keyed by the SHA-256 of the prompt's JSON string form. Plain UTF-8 would map every lone
 * surrogate to the same replacement bytes, giving two different prompts one key; JSON escapes
 * them (`\ud800`), so the key is one-to-one over every string the schemas accept.
 */
export const promptHash = (prompt: string): string =>
	createHash('sha256').update(JSON.stringify(prompt), 'utf8').digest('hex');

export const emptyState = (): State => ({ version: 2, schedules: [], runs: [], prompts: {} });

function checkStore(stored: StoredState): void {
	for (const [key, prompt] of Object.entries(stored.prompts))
		if (promptHash(prompt) !== key) throw new Error('Schedule prompt store hash mismatch.');
	for (const run of stored.runs)
		if (stored.prompts[run.promptSha256] === undefined)
			throw new Error('Scheduled run refers to a missing prompt.');
}

/** Parse a version 2 file and put each run's exact prompt back in its schema position. */
export function decodeScheduleState(raw: string): State {
	const stored = storedState.parse(JSON.parse(raw) as unknown);
	checkStore(stored);
	// Built directly, not re-parsed: the trimming run schema must never alter a stored prompt.
	const runs = stored.runs.map(({ promptSha256, ...rest }): ScheduledRun => {
		const prompt = stored.prompts[promptSha256];
		if (prompt === undefined) throw new Error('Scheduled run refers to a missing prompt.');
		const { id, scheduleId, owner, title, ...tail } = rest;
		return { id, scheduleId, owner, title, prompt, ...tail };
	});
	return {
		version: 2,
		schedules: stored.schedules,
		runs,
		prompts: stored.prompts,
		...(stored.warnedStep === undefined ? {} : { warnedStep: stored.warnedStep }),
	};
}

/** Back to the stored shape. The existing prompt map is kept whole and only grows. */
export function storeScheduleState(
	state: PublicScheduleState & { prompts?: Record<string, string>; warnedStep?: number },
): StoredState {
	const prompts = { ...state.prompts };
	const runs = state.runs.map(({ prompt, ...rest }) => {
		const promptSha256 = promptHash(prompt);
		prompts[promptSha256] = prompt;
		return { ...rest, promptSha256 };
	});
	return {
		version: 2,
		schedules: state.schedules,
		prompts,
		runs,
		...(state.warnedStep === undefined ? {} : { warnedStep: state.warnedStep }),
	};
}

/** The only serializer for saved state. It refuses a run carrying its prompt or a damaged store. */
export function encodeScheduleState(stored: StoredState): string {
	const valid = storedState.parse(stored);
	checkStore(valid);
	return JSON.stringify(valid);
}
