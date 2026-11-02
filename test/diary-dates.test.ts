import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { addDiary, readDiary } from '../src/diary.ts';
import { newRecord, saveAgent } from '../src/store.ts';
import { diaryRejection } from './fixtures/diary.ts';

async function fixture(work: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'summon-diary-dates-'));
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = root;
	try {
		await work(root);
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await rm(root, { recursive: true, force: true });
	}
}

test('original dates retain their precision and do not replace the recording time', async () =>
	fixture(async () => {
		const started = Date.now();
		const day = await addDiary({
			for: 'Phillip',
			task: 'Completed on a known day',
			happenedAt: '2026-09-28',
		});
		const instant = await addDiary({
			for: 'Phillip',
			task: 'Completed at a known time',
			happenedAt: '2026-09-29T09:51:49-05:00',
		});
		expect(day.happenedAt).toBe('2026-09-28');
		expect(instant.happenedAt).toBe('2026-09-29T09:51:49-05:00');
		expect(Date.parse(day.at)).toBeGreaterThanOrEqual(started);
		expect(Date.parse(instant.at)).toBeGreaterThanOrEqual(started);
		expect(day.author).toEqual({ kind: 'operator', id: 'operator' });
		const loaded = (await readDiary()).entries;
		expect(loaded.find((entry) => entry.id === day.id)?.happenedAt).toBe(day.happenedAt);
		expect(loaded.find((entry) => entry.id === instant.id)?.happenedAt).toBe(
			instant.happenedAt,
		);
	}));

test('invalid days and timestamps without a timezone cannot write Diary entries', async () =>
	fixture(async () => {
		for (const happenedAt of ['2026-02-30', '2026-09-28T12:00:00', 'yesterday', '', 12, null]) {
			expect(
				await diaryRejection(
					addDiary({ for: 'Phillip', task: 'Invalid original date', happenedAt }),
				),
			).toBeInstanceOf(Error);
		}
		expect((await readDiary()).entries).toHaveLength(0);
	}));

test('all four provider records use the shared date CLI without losing attribution or spaces', async () =>
	fixture(async (root) => {
		for (const provider of ['claude', 'codex', 'grok', 'kilo'] as const) {
			const name = `date-${provider}`;
			const nonce = `fixture-${provider}`;
			await saveAgent(name, newRecord(name, root, provider));
			await initializeActivity(name, nonce);
			const child = Bun.spawn(
				[
					process.execPath,
					'src/cli.ts',
					'--diary',
					'add',
					JSON.stringify({
						for: 'Phillip',
						task: 'Repaired 12 entries with original dates',
						happenedAt: '2026-09-29',
					}),
				],
				{
					env: {
						...process.env,
						SUMMON_HOME: root,
						SUMMON_AGENT: name,
						SUMMON_NONCE: nonce,
					},
					stdout: 'pipe',
					stderr: 'pipe',
				},
			);
			const [code, output, error] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(error).toBe('');
			expect(code).toBe(0);
			const entry: unknown = JSON.parse(output);
			expect(entry).toMatchObject({
				author: { kind: 'agent', id: name },
				happenedAt: '2026-09-29',
				task: 'Repaired 12 entries with original dates',
			});
		}
		expect((await readDiary()).entries).toHaveLength(4);
	}));
