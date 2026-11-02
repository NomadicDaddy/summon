import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DiaryBackfillPlan } from '../src/diary-backfill-model.ts';

import { setCommunicationPause } from '../src/communication-state.ts';
import { diaryEntryHash } from '../src/diary-backfill-model.ts';
import { applyDiaryBackfill, preflightDiaryBackfill } from '../src/diary-backfill.ts';
import { addDiary, diaryPath, readDiary } from '../src/diary.ts';
import { diaryRejection, withDiaryFixture } from './fixtures/diary.ts';

function plan(root: string): DiaryBackfillPlan {
	return {
		version: 1,
		id: crypto.randomUUID(),
		teamRoot: root,
		approvalRoom: [6768],
		operations: [
			{
				kind: 'add',
				entry: {
					id: crypto.randomUUID(),
					author: { kind: 'agent', id: 'writer' },
					for: 'Phillip',
					task: 'Completed historical work',
					happenedAt: '2026-09-29',
					room: [],
					board: [],
				},
			},
		],
	};
}

test('batch backs up exact bytes, preserves unrelated values and recording identities, then repeats without writes', async () =>
	withDiaryFixture(async (root) => {
		const corrected = await addDiary({ for: 'Phillip', task: 'Historical date prefix' });
		const duplicate = await addDiary({ for: 'Phillip', task: 'Approved duplicate' });
		const untouched = await addDiary({ for: 'Phillip', task: 'Unrelated result' });
		const original = JSON.parse(await readFile(diaryPath(), 'utf8')) as {
			version: 1;
			entries: Record<string, unknown>[];
		};
		const rawUntouched = original.entries.find((entry) => entry.id === untouched.id);
		if (!rawUntouched) throw new Error('Missing raw fixture.');
		rawUntouched.task = '  Unrelated spacing stays exactly as stored  ';
		await writeFile(diaryPath(), JSON.stringify(original, null, 2));
		const before = await readFile(diaryPath(), 'utf8');
		const batch = plan(root);
		batch.operations.push(
			{
				kind: 'update',
				id: corrected.id,
				expectedSha256: diaryEntryHash(corrected),
				changes: {
					task: 'Completed historical result',
					happenedAt: '2026-09-29T12:30:00-05:00',
				},
			},
			{ kind: 'remove', id: duplicate.id, expectedSha256: diaryEntryHash(duplicate) },
		);
		const preview = await preflightDiaryBackfill(batch);
		expect(preview.counts).toEqual({ added: 1, updated: 1, removed: 1, skipped: 0 });
		expect(preview.processShutdownChecked).toBe(false);
		expect(await readFile(diaryPath(), 'utf8')).toBe(before);
		const backup = join(root, 'diary', 'backups', `backfill-${batch.id}.json`);
		expect(await Bun.file(backup).exists()).toBe(false);
		const applied = await applyDiaryBackfill(batch);
		expect(applied.counts).toEqual(preview.counts);
		expect(applied.backup).toBe(backup);
		expect(await readFile(backup, 'utf8')).toBe(before);
		const rows = (await readDiary()).entries;
		const repaired = rows.find((entry) => entry.id === corrected.id);
		expect(repaired).toMatchObject({
			id: corrected.id,
			at: corrected.at,
			author: corrected.author,
			task: 'Completed historical result',
			happenedAt: '2026-09-29T12:30:00-05:00',
			room: corrected.room,
			board: corrected.board,
		});
		expect(rows.some((entry) => entry.id === duplicate.id)).toBe(false);
		expect(rows.find((entry) => entry.author.id === 'writer')?.happenedAt).toBe('2026-09-29');
		const written = await readFile(diaryPath(), 'utf8');
		const stored = JSON.parse(written) as { entries: Record<string, unknown>[] };
		expect(stored.entries.find((entry) => entry.id === untouched.id)).toEqual(rawUntouched);
		const repeated = await applyDiaryBackfill(batch);
		expect(repeated.counts).toEqual({ added: 0, updated: 0, removed: 0, skipped: 3 });
		expect(repeated.backup).toBeNull();
		expect(await readFile(diaryPath(), 'utf8')).toBe(written);
		expect(await readFile(backup, 'utf8')).toBe(before);
	}));

test('a stale target rejects the whole batch without backup or partial additions', async () =>
	withDiaryFixture(async (root) => {
		const target = await addDiary({ for: 'Phillip', task: 'First value' });
		const batch = plan(root);
		batch.operations.push({
			kind: 'update',
			id: target.id,
			expectedSha256: diaryEntryHash(target),
			changes: { happenedAt: '2026-09-29' },
		});
		await writeFile(
			diaryPath(),
			JSON.stringify({ version: 1, entries: [{ ...target, task: 'Later human edit' }] }),
		);
		const before = await readFile(diaryPath(), 'utf8');
		expect((await diaryRejection(applyDiaryBackfill(batch))).message).toContain(
			'changed since the plan',
		);
		expect(await readFile(diaryPath(), 'utf8')).toBe(before);
		expect(
			await Bun.file(join(root, 'diary', 'backups', `backfill-${batch.id}.json`)).exists(),
		).toBe(false);
	}));

test('normal concurrent entries survive the batch and prototype-named authors get accurate counts', async () =>
	withDiaryFixture(async (root) => {
		const target = await addDiary({ for: 'Phillip', task: 'Original result' });
		const batch = plan(root);
		const addition = batch.operations[0];
		if (!addition || addition.kind !== 'add') throw new Error('Missing addition.');
		addition.entry.author.id = 'constructor';
		batch.operations.push({
			kind: 'update',
			id: target.id,
			expectedSha256: diaryEntryHash(target),
			changes: { happenedAt: '2026-09-29' },
		});
		const [applied, ordinary] = await Promise.all([
			applyDiaryBackfill(batch),
			addDiary({ for: 'Phillip', task: 'Independent work while importing' }),
		]);
		expect(
			Object.entries(applied.authors).find(([name]) => name === 'constructor')?.[1],
		).toEqual({
			added: 1,
			updated: 0,
			removed: 0,
			skipped: 0,
		});
		const rows = (await readDiary()).entries;
		expect(rows).toHaveLength(3);
		expect(rows.find((entry) => entry.id === ordinary.id)).toEqual(ordinary);
		expect(rows.find((entry) => entry.id === target.id)?.at).toBe(target.at);
	}));

test('wrong roots, authors, references and attempted attribution changes cannot mutate the store', async () =>
	withDiaryFixture(async (root) => {
		await addDiary({ for: 'Phillip', task: 'Protected original' });
		const before = await readFile(diaryPath(), 'utf8');
		const wrongRoot = plan(root);
		wrongRoot.teamRoot = join(root, 'another-team');
		expect((await diaryRejection(applyDiaryBackfill(wrongRoot))).message).toContain(
			'another team root',
		);
		const missingAuthor = plan(root);
		const addition = missingAuthor.operations[0];
		if (!addition || addition.kind !== 'add') throw new Error('Missing addition.');
		addition.entry.author.id = 'unregistered';
		expect((await diaryRejection(applyDiaryBackfill(missingAuthor))).message).toContain(
			'registered or recorded',
		);
		addition.entry.author.id = 'writer';
		addition.entry.room = [999999999];
		expect((await diaryRejection(applyDiaryBackfill(missingAuthor))).message).toContain(
			'message not found',
		);
		const target = (await readDiary()).entries[0];
		if (!target) throw new Error('Missing target.');
		expect(
			await diaryRejection(
				applyDiaryBackfill({
					...plan(root),
					operations: [
						{
							kind: 'update',
							id: target.id,
							expectedSha256: diaryEntryHash(target),
							changes: { author: { kind: 'agent', id: 'writer' } },
						},
					],
				}),
			),
		).toBeInstanceOf(Error);
		expect(await readFile(diaryPath(), 'utf8')).toBe(before);
	}));

test('named agents can inspect a plan but cannot apply it; the communication hold still protects operator writes', async () =>
	withDiaryFixture(async (root) => {
		await addDiary({ for: 'Phillip', task: 'Original' });
		const before = await readFile(diaryPath(), 'utf8');
		const batch = plan(root);
		const previous = process.env.SUMMON_AGENT;
		process.env.SUMMON_AGENT = 'fixture-agent';
		try {
			expect((await preflightDiaryBackfill(batch)).readOnly).toBe(true);
			expect((await diaryRejection(applyDiaryBackfill(batch))).message).toContain(
				'human operator only',
			);
		} finally {
			if (previous === undefined) delete process.env.SUMMON_AGENT;
			else process.env.SUMMON_AGENT = previous;
		}
		await setCommunicationPause(true);
		expect((await diaryRejection(applyDiaryBackfill(batch))).message).toContain('paused');
		expect(await readFile(diaryPath(), 'utf8')).toBe(before);
		expect(
			await Bun.file(join(root, 'diary', 'backups', `backfill-${batch.id}.json`)).exists(),
		).toBe(false);
	}));
