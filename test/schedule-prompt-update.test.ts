import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
	createSchedule,
	dispatchSchedules,
	finishScheduledRun,
	listSchedules,
} from '../src/schedules.ts';
import { newRecord, type Provider } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
const initial = 'Review fixture changes only.';
const replacement = 'Review fixture changes and preserve literal \\a 😀\nsecond line.';
const input = { owner: 'alpha', title: 'Review', everyMinutes: 10, prompt: initial };
const edit = (expectedPrompt = initial, prompt = replacement) =>
	JSON.stringify({ expectedPrompt, prompt });
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

test('only the owner or operator can update; invalid and stale edits preserve exact bytes', async () => {
	const schedule = await createSchedule(input);
	const before = await fixture.read('schedules/state.json');
	for (const [agent, body, overrides] of [
		['beta', edit(), {}],
		['alpha', edit(), { SUMMON_NONCE: '' }],
		['alpha', edit('stale'), {}],
		['alpha', edit(initial, ' '), {}],
		['alpha', edit(initial, 'x'.repeat(8001)), {}],
		['alpha', edit(initial, '\0'), {}],
		[
			'alpha',
			JSON.stringify({ expectedPrompt: initial, prompt: replacement, enabled: true }),
			{},
		],
	] satisfies [string, string, Record<string, string>][]) {
		expect(
			(
				await fixture.run(
					['--schedule', 'update-prompt', schedule.id, body],
					agent,
					overrides,
				)
			).code,
		).toBe(1);
		expect(await fixture.read('schedules/state.json')).toBe(before);
	}
	expect(
		(await fixture.run(['--schedule', 'update-prompt', schedule.id, edit()], 'alpha')).code,
	).toBe(0);
	expect((await listSchedules()).schedules[0]).toEqual({ ...schedule, prompt: replacement });
	expect(
		(
			await fixture.run([
				'--schedule',
				'update-prompt',
				schedule.id,
				edit(replacement, initial),
			])
		).code,
	).toBe(0);
	expect((await listSchedules()).schedules[0]).toEqual(schedule);
});

test('competing processes accept exactly one expected-prompt edit', async () => {
	const schedule = await createSchedule(input);
	const results = await Promise.all(
		['one', 'two'].map((prompt) =>
			fixture.run(
				['--schedule', 'update-prompt', schedule.id, edit(initial, prompt)],
				'alpha',
			),
		),
	);
	expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
	expect(results.find((result) => result.code === 1)?.error).toContain('Schedule prompt changed');
	const winner = (await listSchedules()).schedules[0];
	if (!winner) throw new Error('Expected retained schedule');
	expect(['one', 'two']).toContain(winner.prompt);
});

test('edits preserve paused deferral and delivered/completed run snapshots; future runs use new scope', async () => {
	const schedule = await createSchedule(input);
	const dispatch = (now: number) =>
		dispatchSchedules(
			() => Promise.resolve(true),
			() => Promise.resolve(),
			now,
		);
	await dispatch(schedule.nextDueAt);
	const before = await listSchedules();
	const run = before.runs[0];
	if (!run) throw new Error('Expected delivered run');
	before.schedules[0] = {
		...schedule,
		enabled: false,
		deferred: {
			reason: 'owner-busy',
			dueAt: schedule.nextDueAt,
			observedAt: schedule.nextDueAt,
		},
	};
	await writeFile(join(fixture.records, 'schedules/state.json'), JSON.stringify(before));
	expect(
		(await fixture.run(['--schedule', 'update-prompt', schedule.id, edit()], 'alpha')).code,
	).toBe(0);
	expect(await listSchedules()).toEqual({
		...before,
		schedules: [{ ...before.schedules[0], prompt: replacement }],
	});
	await finishScheduledRun(run.id, 'complete', 'Verified old instructions.');
	const complete = (await listSchedules()).runs;
	expect(
		(
			await fixture.run([
				'--schedule',
				'update-prompt',
				schedule.id,
				edit(replacement, 'Future scope'),
			])
		).code,
	).toBe(0);
	expect((await listSchedules()).runs).toEqual(complete);
	expect((await fixture.run(['--schedule', 'resume', schedule.id], 'alpha')).code).toBe(0);
	await dispatch(schedule.nextDueAt + 600000);
	const after = await listSchedules();
	expect(after.runs[0]).toEqual(complete[0]);
	expect(after.runs[1]?.prompt).toBe('Future scope');
	expect(after.runs[1]?.scheduleId).toBe(schedule.id);
});

test('UTF-8 JSON file input works for Claude, Codex, Grok and Kilo own sessions', async () => {
	const path = join(fixture.root, 'prompt edit.json');
	for (const provider of ['claude', 'codex', 'grok', 'kilo'] satisfies Provider[]) {
		await writeFile(
			join(fixture.records, `${provider}.json`),
			JSON.stringify(newRecord(provider, fixture.root, provider)),
		);
		const schedule = await createSchedule({ ...input, owner: provider });
		await writeFile(path, edit());
		expect(
			(
				await fixture.run(
					['--schedule', 'update-prompt', schedule.id, '--body-file', path],
					provider,
				)
			).code,
		).toBe(0);
		expect((await listSchedules()).schedules.find((item) => item.id === schedule.id)).toEqual({
			...schedule,
			prompt: replacement,
		});
	}
});

test('unsafe file or mixed input, malformed JSON and unknown IDs cannot change schedules', async () => {
	const schedule = await createSchedule(input);
	const before = await fixture.read('schedules/state.json');
	const path = join(fixture.root, 'bad.json');
	await writeFile(path, new Uint8Array([0xc3, 0x28]));
	expect(
		(
			await fixture.run(
				['--schedule', 'update-prompt', schedule.id, '--body-file', path],
				'alpha',
			)
		).code,
	).toBe(1);
	const privatePath = join(fixture.records, 'runtime/beta/edit.json');
	await mkdir(join(fixture.records, 'runtime/beta'), { recursive: true });
	await writeFile(privatePath, edit());
	for (const args of [
		[schedule.id, '--body-file', privatePath],
		[schedule.id, edit(), '--body-file', path],
		[schedule.id, '{broken'],
		['00000000-0000-4000-8000-000000000000', edit()],
		['bad-id', edit()],
	])
		expect((await fixture.run(['--schedule', 'update-prompt', ...args], 'alpha')).code).toBe(1);
	expect(await fixture.read('schedules/state.json')).toBe(before);
});
