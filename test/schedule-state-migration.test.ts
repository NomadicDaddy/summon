import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { scheduleStateV1ToV2, scheduleStateV2ToV1 } from '../src/schedule-state-migration.ts';
import {
	decodeScheduleState,
	encodeScheduleState,
	storeScheduleState,
} from '../src/schedule-store.ts';

const scheduleId = randomUUID();
const schedule = {
	owner: 'alpha',
	title: 'Stall check',
	everyMinutes: 30,
	prompt: 'Check the room for stalls.',
	id: scheduleId,
	enabled: true,
	nextDueAt: 1795000000000,
};
// The live v1 layout: prompt sits after title, result is present only once a run finishes.
const run = (n: number, prompt: string, result?: string) => ({
	id: randomUUID(),
	scheduleId,
	owner: 'alpha',
	title: 'Stall check',
	prompt,
	dueAt: 1794000000000 + n,
	updatedAt: 1794000000500 + n,
	status: result === undefined ? 'delivered' : 'complete',
	...(result === undefined ? {} : { result }),
});
const v1 = (runs: Record<string, unknown>[]) =>
	JSON.stringify({ version: 1, schedules: [schedule], runs });

test('a v1 file converts to v2 and back to the exact same bytes, prompts stored once', () => {
	const padded = '  Padded prompt, 😀 and \\a kept.\n ';
	const raw = v1([
		run(1, schedule.prompt, 'Done.'),
		run(2, schedule.prompt, 'Done again.'),
		run(3, padded),
	]);
	const converted = scheduleStateV1ToV2(raw);
	expect(scheduleStateV2ToV1(converted)).toBe(raw);
	const parsed = JSON.parse(converted) as { prompts: Record<string, string>; runs: object[] };
	expect(Object.values(parsed.prompts)).toEqual([schedule.prompt, padded]);
	for (const item of parsed.runs) expect(Object.keys(item)).not.toContain('prompt');
	expect(decodeScheduleState(converted).runs.map((item) => item.prompt)).toEqual([
		schedule.prompt,
		schedule.prompt,
		padded,
	]);
});

test('a long prompt repeated across runs is stored once, so the file shrinks', () => {
	const long = `Check the room for stalls. ${'Read every unanswered item. '.repeat(200)}`;
	const raw = v1(Array.from({ length: 20 }, (_, n) => run(n, long, 'Done.')));
	const converted = scheduleStateV1ToV2(raw);
	expect(scheduleStateV2ToV1(converted)).toBe(raw);
	expect(Buffer.byteLength(converted)).toBeLessThan(Buffer.byteLength(raw) / 5);
});

test('an unknown key, a changed byte, a wrong version or a run without a prompt stops the migration', () => {
	const good = run(1, schedule.prompt, 'Done.');
	for (const raw of [
		v1([{ ...good, extra: 'unknown' }]),
		`${v1([good])}\n`,
		v1([good]).replace('"version":1', '"version": 1'),
		JSON.stringify({ version: 2, schedules: [schedule], runs: [good] }),
		v1([{ ...good, prompt: 7 }]),
		v1([{ ...good, promptSha256: 'x'.repeat(64) }]),
	])
		expect(() => scheduleStateV1ToV2(raw)).toThrow('migration refused');
});

test('rollback restores every prompt into its run and keeps runs made after the migration', () => {
	const raw = v1([run(1, schedule.prompt, 'Done.')]);
	const state = decodeScheduleState(scheduleStateV1ToV2(raw));
	const later = { ...run(2, 'A newer scope.'), status: 'delivered' as const };
	state.runs.push(later);
	state.warnedStep = 1;
	const back = JSON.parse(
		scheduleStateV2ToV1(encodeScheduleState(storeScheduleState(state))),
	) as {
		version: number;
		runs: { id: string; prompt: string }[];
	} & Record<string, unknown>;
	expect(back.version).toBe(1);
	expect(back.runs.map((item) => item.prompt)).toEqual([schedule.prompt, 'A newer scope.']);
	expect(back.runs[1]?.id).toBe(later.id);
	expect(Object.keys(back)).toEqual(['version', 'schedules', 'runs']);
});

test('rollback refuses a damaged prompt store', () => {
	const converted = JSON.parse(scheduleStateV1ToV2(v1([run(1, schedule.prompt)]))) as {
		prompts: Record<string, string>;
	};
	for (const key of Object.keys(converted.prompts)) converted.prompts[key] = 'tampered';
	expect(() => scheduleStateV2ToV1(JSON.stringify(converted))).toThrow('rollback refused');
	expect(() => scheduleStateV2ToV1(JSON.stringify({ ...converted, prompts: {} }))).toThrow(
		'rollback refused',
	);
});
