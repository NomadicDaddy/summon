import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { decodeScheduleState, encodeScheduleState, promptHash } from '../src/schedule-store.ts';
import {
	createSchedule,
	dispatchSchedules,
	enableSchedule,
	finishScheduledRun,
	listSchedules,
	removeScheduleOwner,
	updateSchedulePrompt,
} from '../src/schedules.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

const shared = 'Shared fixture scope, stored once.';
const dispatch = (now: number) =>
	dispatchSchedules(
		() => Promise.resolve(true),
		() => Promise.resolve(),
		now,
	);
type Stored = { prompts: Record<string, string>; runs: Record<string, unknown>[] };
const stored = async (): Promise<Stored> =>
	JSON.parse(await fixture.read('schedules/state.json')) as Stored;
const noPromptInRuns = async () => {
	for (const run of (await stored()).runs) expect(Object.keys(run)).not.toContain('prompt');
};

test('each writer saves runs by hash only, and two schedules with one prompt share one entry', async () => {
	const alpha = await createSchedule({
		owner: 'alpha',
		title: 'A',
		everyMinutes: 1,
		prompt: shared,
	});
	const beta = await createSchedule({
		owner: 'beta',
		title: 'B',
		everyMinutes: 1,
		prompt: shared,
	});
	await dispatch(Math.max(alpha.nextDueAt, beta.nextDueAt));
	await noPromptInRuns();
	const after = await stored();
	expect(Object.keys(after.prompts)).toEqual([promptHash(shared)]);
	expect(after.runs).toHaveLength(2);
	const [first] = (await listSchedules()).runs;
	if (!first) throw new Error('Expected a dispatched run');
	await finishScheduledRun(first.id, 'complete', 'Fixture evidence.');
	await noPromptInRuns();
	await updateSchedulePrompt(alpha.id, { expectedPrompt: shared, prompt: 'Later scope.' });
	await noPromptInRuns();
	await enableSchedule(beta.id, false);
	await noPromptInRuns();
	await removeScheduleOwner('beta', () => Promise.resolve());
	await noPromptInRuns();
	// A run keeps the exact prompt it was dispatched with after its schedule's prompt changes.
	const runs = (await listSchedules()).runs;
	expect(runs.map((run) => run.prompt)).toEqual([shared, shared]);
	expect((await listSchedules()).schedules[0]?.prompt).toBe('Later scope.');
});

test('a stored prompt reads back byte for byte, padding and non-ASCII included', () => {
	const prompt = '  Leading and trailing spaces stay. \\a 😀\nsecond line.  ';
	const run = {
		id: randomUUID(),
		scheduleId: randomUUID(),
		owner: 'alpha',
		title: 'Exact',
		prompt,
		dueAt: 1,
		updatedAt: 2,
		status: 'complete' as const,
		result: 'Kept.',
	};
	const decoded = decodeScheduleState(
		encodeScheduleState({ version: 2, schedules: [], runs: [run] }),
	);
	expect(decoded.runs).toEqual([run]);
	expect(decoded.runs[0]?.prompt).toBe(prompt);
});

test('a missing entry, an altered prompt, a wrong key or a run with its prompt refuses the file', async () => {
	await createSchedule({ owner: 'alpha', title: 'A', everyMinutes: 1, prompt: shared });
	await dispatch(Date.now() + 120000);
	const good = await stored();
	const key = promptHash(shared);
	const [run] = good.runs;
	if (!run) throw new Error('Expected a stored run');
	const variants = [
		{ ...good, prompts: {} },
		{ ...good, prompts: { [key]: `${shared} altered` } },
		{ ...good, prompts: { [promptHash('other')]: shared } },
		{ ...good, runs: [{ ...run, prompt: shared }] },
		{ ...good, version: 1 },
	];
	for (const variant of variants) {
		await writeFile(join(fixture.records, 'schedules/state.json'), JSON.stringify(variant));
		const result: unknown = await listSchedules().catch((error: unknown) => error);
		expect(result).toBeInstanceOf(Error);
	}
});

test('an agent sees only its own runs and prompts, and no prompt store', async () => {
	await createSchedule({ owner: 'alpha', title: 'Own', everyMinutes: 1, prompt: 'alpha scope' });
	await createSchedule({ owner: 'beta', title: 'Other', everyMinutes: 1, prompt: 'beta secret' });
	await dispatch(Date.now() + 120000);
	expect(Object.keys(await listSchedules())).not.toContain('prompts');
	const listed = await fixture.run(['--schedule', 'list'], 'alpha');
	expect(listed.code).toBe(0);
	expect(listed.out).toContain('alpha scope');
	expect(listed.out).not.toContain('beta secret');
	expect(listed.out).not.toContain('"prompts"');
	const [own] = (JSON.parse(listed.out) as { runs: { id: string }[] }).runs;
	const shown = await fixture.run(['--schedule', 'run', own?.id ?? ''], 'alpha');
	expect(shown.out).toContain('alpha scope');
});
