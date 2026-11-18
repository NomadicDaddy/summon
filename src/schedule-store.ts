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
/** Hydrated working state. The prompt map stays inside this module and never reaches a caller. */
export type State = {
	version: 2;
	schedules: Schedule[];
	runs: ScheduledRun[];
	warnedStep?: number;
};

export const promptHash = (prompt: string): string =>
	createHash('sha256').update(prompt, 'utf8').digest('hex');

export const emptyState = (): State => ({ version: 2, schedules: [], runs: [] });

/** Parse a version 2 file and put each run's exact prompt back in its schema position. */
export function decodeScheduleState(raw: string): State {
	const stored = storedState.parse(JSON.parse(raw) as unknown);
	for (const [key, prompt] of Object.entries(stored.prompts))
		if (promptHash(prompt) !== key) throw new Error('Schedule prompt store hash mismatch.');
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
		...(stored.warnedStep === undefined ? {} : { warnedStep: stored.warnedStep }),
	};
}

/** The only serializer for saved state: each prompt is stored once and runs keep its hash. */
export function encodeScheduleState(state: State): string {
	const prompts: Record<string, string> = {};
	const runs = state.runs.map((item) => {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(item)) {
			if (key !== 'prompt') {
				out[key] = value;
				continue;
			}
			const hash = promptHash(item.prompt);
			prompts[hash] = item.prompt;
			out.promptSha256 = hash;
		}
		return out;
	});
	const stored = storedState.parse({
		version: 2,
		schedules: state.schedules,
		prompts,
		runs,
		...(state.warnedStep === undefined ? {} : { warnedStep: state.warnedStep }),
	});
	return JSON.stringify(stored);
}
