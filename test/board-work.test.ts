import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { boardWork, createBoardItem, readBoard, updateBoardItem } from '../src/board.ts';
import { newRecord, saveAgent } from '../src/store.ts';

test('board work lists only what a name can start, cheaply and in lane order', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-board-work-'));
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = root;
	try {
		await saveAgent('lead', newRecord('Lead', root, 'codex'));
		await saveAgent('peer', newRecord('Peer', root, 'claude'));
		const lanes = [
			['backlog', 'Undecided'],
			['ready', 'Decided and mine'],
			['doing', 'Already started'],
			['blocked', 'Cannot proceed'],
			['review', 'Waiting on someone'],
			['done', 'Finished'],
		] as const;
		for (const [state, title] of lanes) {
			const created = await createBoardItem({ title, owner: 'lead' });
			const id = created.items.find((item) => item.title === title)?.id ?? '';
			// A freshly created card is at item revision 1, which is not the board's revision.
			if (state !== 'backlog')
				await updateBoardItem(id, 1, {
					state,
					...(state === 'blocked'
						? {
								blockedOn: {
									kind: 'human',
									target: 'operator',
									reason: 'needs a call',
								},
							}
						: {}),
				});
		}
		const other = await createBoardItem({ title: 'Not mine', owner: 'peer' });
		await updateBoardItem(other.items.find((item) => item.title === 'Not mine')?.id ?? '', 1, {
			state: 'ready',
		});
		const work = await boardWork('lead');
		expect(await boardWork(' Lead ')).toEqual(work);
		let invalid: unknown;
		await boardWork('../lead').catch((error: unknown) => {
			invalid = error;
		});
		expect(invalid).toBeDefined();
		// doing before ready, so a session resumes rather than opening something new beside it.
		expect(work.items.map((item) => item.title)).toEqual([
			'Already started',
			'Decided and mine',
		]);
		expect(work.owner).toBe('lead');
		// The cost saving is the point: titles only, no description or evidence to carry.
		expect(Object.keys(work.items[0] ?? {}).sort()).toEqual([
			'id',
			'project',
			'state',
			'title',
		]);
		expect(JSON.stringify(work).length).toBeLessThan(
			JSON.stringify(await readBoard()).length / 2,
		);
		// Another name's ready work is never offered as yours, and is still there under their own.
		const theirs = await boardWork('peer');
		expect(theirs.owner).toBe('peer');
		expect(theirs.items.map((item) => item.title)).toEqual(['Not mine']);
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await rm(root, { recursive: true, force: true });
	}
});
