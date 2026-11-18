import { decodeScheduleState, promptHash } from './schedule-store.ts';

type Json = Record<string, unknown>;

function object(value: unknown, what: string): Json {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error(`${what} is not an object; migration refused.`);
	return value as Json;
}

function list(value: unknown, what: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${what} is not a list; migration refused.`);
	return value;
}

/** Swap one key for another in place, so every other key keeps its position and its bytes. */
function swapKey(source: Json, from: string, to: string, value: unknown): Json {
	const out: Json = {};
	let seen = false;
	for (const [key, item] of Object.entries(source)) {
		if (key === to) throw new Error(`A scheduled run already has ${to}; migration refused.`);
		if (key === from) {
			out[to] = value;
			seen = true;
		} else out[key] = item;
	}
	if (!seen) throw new Error(`A scheduled run has no ${from}; migration refused.`);
	return out;
}

/**
 * Raw JSON only, never the zod schemas, so no key is stripped and no string is trimmed. The result
 * must turn back into the exact input bytes and must be accepted by the version 2 reader.
 */
export function scheduleStateV1ToV2(raw: string): string {
	const v1 = object(JSON.parse(raw) as unknown, 'Schedule state');
	if (v1.version !== 1) throw new Error('Schedule state is not version 1; migration refused.');
	const prompts: Record<string, string> = {};
	const runs = list(v1.runs, 'Scheduled runs').map((entry) => {
		const run = object(entry, 'A scheduled run');
		if (typeof run.prompt !== 'string')
			throw new Error('A scheduled run has no prompt text; migration refused.');
		const hash = promptHash(run.prompt);
		prompts[hash] = run.prompt;
		return swapKey(run, 'prompt', 'promptSha256', hash);
	});
	const v2: Json = {};
	for (const [key, value] of Object.entries(v1)) {
		if (key === 'version') v2.version = 2;
		else if (key === 'runs') {
			v2.prompts = prompts;
			v2.runs = runs;
		} else v2[key] = value;
	}
	const encoded = JSON.stringify(v2);
	if (scheduleStateV2ToV1(encoded) !== raw)
		throw new Error('Schedule state does not round-trip byte for byte; migration refused.');
	try {
		decodeScheduleState(encoded);
	} catch (error: unknown) {
		throw new Error('The version 2 reader refuses the converted state; migration refused.', {
			cause: error,
		});
	}
	return encoded;
}

/** Rollback for the version 1 build: every prompt goes back into its run, newer runs included. */
export function scheduleStateV2ToV1(raw: string): string {
	const v2 = object(JSON.parse(raw) as unknown, 'Schedule state');
	if (v2.version !== 2) throw new Error('Schedule state is not version 2; rollback refused.');
	const prompts = object(v2.prompts, 'The prompt store');
	for (const [key, prompt] of Object.entries(prompts))
		if (typeof prompt !== 'string' || promptHash(prompt) !== key)
			throw new Error('Schedule prompt store hash mismatch; rollback refused.');
	const runs = list(v2.runs, 'Scheduled runs').map((entry) => {
		const run = object(entry, 'A scheduled run');
		const prompt = typeof run.promptSha256 === 'string' ? prompts[run.promptSha256] : undefined;
		if (typeof prompt !== 'string')
			throw new Error('A scheduled run refers to a missing prompt; rollback refused.');
		return swapKey(run, 'promptSha256', 'prompt', prompt);
	});
	const v1: Json = {};
	for (const [key, value] of Object.entries(v2)) {
		if (key === 'version') v1.version = 1;
		else if (key === 'runs') v1.runs = runs;
		else if (key !== 'prompts' && key !== 'warnedStep') v1[key] = value;
	}
	return JSON.stringify(v1);
}
