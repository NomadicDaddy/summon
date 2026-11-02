import { expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rotateBoardHistory } from '../src/board-history.ts';
import { boardDocumentSchema, boardSnapshotSchema } from '../src/board-model.ts';
import {
	addBoardComment,
	boardHistory,
	createBoardItem,
	readBoard,
	updateBoardItem,
} from '../src/board.ts';
import { newRecord, saveAgent } from '../src/store.ts';

test('Board archives committed history, survives an interrupted state write and retains approvals', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-board-history-'));
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = root;
	try {
		await saveAgent('lead', newRecord('Lead', root, 'codex'));
		const created = await createBoardItem({ title: 'Release decision', owner: 'lead' });
		const item = created.items[0];
		if (!item) throw new Error('Missing fixture card.');
		const path = join(root, 'board', 'state.json');
		const data = boardDocumentSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
		const snapshot = boardSnapshotSchema
			.strip()
			.parse({ ...item, description: 'x'.repeat(8000) });
		data.history = Array.from({ length: 200 }, (_, index) => ({
			at: item.createdAt,
			actor: { kind: 'operator' as const, id: 'operator' },
			itemId: item.id,
			before:
				index === 0 ? null : { ...snapshot, revision: index, state: 'blocked' as const },
			after: { ...snapshot, revision: index + 1, state: 'ready' as const },
		}));
		data.items = [
			{ ...item, revision: 200, description: snapshot.description, state: 'ready' },
		];
		data.revision = 200;
		await writeFile(path, JSON.stringify(data));
		expect(Buffer.byteLength(JSON.stringify(data.history))).toBeGreaterThan(2 * 1024 * 1024);
		const expected = structuredClone(data.history);
		// Archive succeeded but the process exited before saving the shortened state document.
		await rotateBoardHistory(structuredClone(data));
		expect(await boardHistory(item.id)).toEqual(expected);
		const files = await readdir(join(root, 'board', 'history'));
		expect(files).toHaveLength(1);
		const updated = await updateBoardItem(item.id, 200, { title: 'Approved release' });
		expect(updated.items[0]?.revision).toBe(201);
		expect(await readdir(join(root, 'board', 'history'))).toEqual(files);
		const history = await boardHistory(item.id);
		expect(history.slice(0, 200)).toEqual(expected);
		expect(history).toHaveLength(201);
		expect(history.at(-1)?.after.title).toBe('Approved release');
		const saved = boardDocumentSchema.parse(
			JSON.parse(await readFile(path, 'utf8')) as unknown,
		);
		expect(Buffer.byteLength(JSON.stringify(saved.history))).toBeLessThan(2 * 1024 * 1024);
		// Cached readers cannot mutate the durable state or miss a subsequent file replacement.
		const firstRead = await readBoard();
		firstRead.items.length = 0;
		expect((await readBoard()).items).toHaveLength(1);
		await addBoardComment(item.id, 'Approval evidence retained.');
		expect((await readBoard()).items[0]?.comments).toHaveLength(1);
		// Corrupt archives fail closed rather than silently dropping an approval record.
		const archive = files[0];
		if (!archive) throw new Error('Missing archive.');
		await writeFile(join(root, 'board', 'history', archive), '{}');
		let failure: unknown;
		await boardHistory(item.id).catch((error: unknown) => {
			failure = error;
		});
		expect(failure).toBeDefined();
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await rm(root, { recursive: true, force: true });
	}
});
