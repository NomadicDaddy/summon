import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { applyDiaryBackfill } from '../src/diary-backfill.ts';
import { addDiary, diaryPath } from '../src/diary.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { loadAgent } from '../src/store.ts';
import { diaryRejection, withDiaryFixture } from './fixtures/diary.ts';

function plan(root: string) {
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
					task: 'Historical outcome',
					happenedAt: '2026-09-29',
					room: [],
					board: [],
				},
			},
		],
	};
}

async function run(args: string[], root: string, named: boolean) {
	const child = Bun.spawn([process.execPath, 'scripts/backfill-diary.ts', ...args], {
		env: {
			...process.env,
			SUMMON_HOME: root,
			...(named ? { SUMMON_AGENT: 'writer', SUMMON_NONCE: 'fixture-backfill' } : {}),
		},
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, stdout, stderr };
}

test('the actual script previews public plans and refuses named writes before reading the body', async () =>
	withDiaryFixture(async (root) => {
		await addDiary({ for: 'Phillip', task: 'Original' });
		const before = await readFile(diaryPath(), 'utf8');
		const file = join(root, 'plan.json');
		await writeFile(file, JSON.stringify(plan(root)));
		const preview = await run(['--preflight', file], root, true);
		expect(preview.code).toBe(0);
		expect(JSON.parse(preview.stdout) as unknown).toMatchObject({
			readOnly: true,
			counts: { added: 1 },
		});
		const denied = await run(['--apply', join(root, 'missing-plan.json')], root, true);
		expect(denied.code).not.toBe(0);
		expect(denied.stderr).toContain('human operator only');
		expect(denied.stderr).not.toContain('ENOENT');
		expect(await readFile(diaryPath(), 'utf8')).toBe(before);
	}));

test('the actual preflight script refuses another teammate private body before JSON parsing', async () =>
	withDiaryFixture(async (root) => {
		const directory = join(root, 'scratch', 'another-fixture-author');
		await mkdir(directory, { recursive: true });
		const file = join(directory, 'private.json');
		await writeFile(file, 'not-json-and-must-not-be-read');
		const denied = await run(['--preflight', file], root, true);
		expect(denied.code).not.toBe(0);
		expect(denied.stderr).toContain('private storage');
		expect(denied.stderr).not.toContain('JSON Parse');
	}));

test('a differing retained backup refuses the complete write without overwriting either snapshot', async () =>
	withDiaryFixture(async (root) => {
		await addDiary({ for: 'Phillip', task: 'Original' });
		const before = await readFile(diaryPath(), 'utf8');
		const batch = plan(root);
		const directory = join(root, 'diary', 'backups');
		await mkdir(directory, { recursive: true });
		const backup = join(directory, `backfill-${batch.id}.json`);
		await writeFile(backup, 'retained prior snapshot');
		expect((await diaryRejection(applyDiaryBackfill(batch))).message).toContain(
			'backup already differs',
		);
		expect(await readFile(backup, 'utf8')).toBe('retained prior snapshot');
		expect(await readFile(diaryPath(), 'utf8')).toBe(before);
	}));

test('backfill rejects the same historical outcome under a new identity', async () =>
	withDiaryFixture(async (root) => {
		const first = plan(root);
		await applyDiaryBackfill(first);
		const before = await readFile(diaryPath(), 'utf8');
		expect((await diaryRejection(applyDiaryBackfill(plan(root)))).message).toContain(
			'already exists under another identity',
		);
		expect(await readFile(diaryPath(), 'utf8')).toBe(before);
	}));

test('a former teammate recorded in public history keeps authorship without recreating a profile', async () =>
	withDiaryFixture(async (root) => {
		await appendLocalEvent({
			sender: { kind: 'agent', id: 'former-author' },
			text: 'Completed historical work',
			replyTo: null,
			source: 'local',
		});
		const batch = plan(root);
		const operation = batch.operations[0];
		if (!operation) throw new Error('Missing operation');
		operation.entry.author.id = 'former-author';
		const result = await applyDiaryBackfill(batch);
		expect(result.counts.added).toBe(1);
		expect(await loadAgent('former-author')).toBeUndefined();
		expect(JSON.parse(await readFile(diaryPath(), 'utf8')) as unknown).toMatchObject({
			entries: [{ author: { kind: 'agent', id: 'former-author' } }],
		});
	}));
