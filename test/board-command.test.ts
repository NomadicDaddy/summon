import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { boardDocumentSchema, boardItemSchema } from '../src/board-model.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

test('Board mutations return only their saved card while list and history remain complete', async () => {
	const h = await mailHarness();
	try {
		expect((await h.run(['--board', 'create', '{"title":"Seed"}'])).code).toBe(0);
		const document = boardDocumentSchema.parse(JSON.parse(await h.read('board/state.json')));
		const seed = document.items[0];
		if (!seed) throw new Error('Missing seed card');
		for (let index = 0; index < 30; index++)
			document.items.push({
				...seed,
				id: randomUUID(),
				title: `Unrelated ${index}`,
				description: 'Unrelated private fixture detail. '.repeat(200),
			});
		await writeFile(join(h.records, 'board/state.json'), JSON.stringify(document));
		const created = await h.run(['--board', 'create', '{"title":"Changed card"}']);
		expect(created.code).toBe(0);
		const receipt = JSON.parse(created.out) as { revision: number; item: unknown };
		let item = boardItemSchema.parse(receipt.item);
		expect(receipt.revision).toBe(2);
		expect(item.title).toBe('Changed card');
		const updated = await h.run([
			'--board',
			'update',
			item.id,
			String(item.revision),
			'{"description":"Saved change"}',
		]);
		expect(updated.code).toBe(0);
		item = boardItemSchema.parse((JSON.parse(updated.out) as { item: unknown }).item);
		expect(item.revision).toBe(2);
		expect(item.description).toBe('Saved change');
		const commented = await h.run(['--board', 'comment', item.id, 'Saved comment']);
		expect(commented.code).toBe(0);
		const saved = boardDocumentSchema.parse(JSON.parse(await h.read('board/state.json')));
		expect((JSON.parse(commented.out) as { item: unknown }).item).toEqual(saved.items.at(-1));
		expect(saved.items.at(-1)?.comments[0]?.body).toBe('Saved comment');
		const listed = await h.run(['--board', 'list']);
		expect(listed.code).toBe(0);
		expect((JSON.parse(listed.out) as { items: unknown[] }).items).toEqual(saved.items);
		for (const result of [created, updated, commented]) {
			expect(Object.keys(JSON.parse(result.out) as object).sort()).toEqual([
				'item',
				'revision',
			]);
			expect(result.out).not.toContain('Unrelated private fixture detail');
			expect(Buffer.byteLength(result.out)).toBeLessThan(Buffer.byteLength(listed.out) / 100);
		}
		const stale = await h.run(['--board', 'update', item.id, '1', '{"title":"Stale"}']);
		expect(stale.code).toBe(1);
		expect(stale.out).toBe('');
		expect(await h.read('board/state.json')).toBe(JSON.stringify(saved));
		const history = await h.run(['--board', 'history', item.id]);
		expect(history.code).toBe(0);
		expect(JSON.parse(history.out) as unknown).toEqual(
			saved.history.filter((change) => change.itemId === item.id),
		);
	} finally {
		await h.dispose();
	}
}, 30_000);
