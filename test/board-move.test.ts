import { expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	boardHistory,
	boardWork,
	createBoardItem,
	readBoard,
	updateBoardItem,
} from '../src/board.ts';
import { setCommunicationPause } from '../src/communication-state.ts';
import { moveBoard, ownBoard } from '../src/desktop/board-move.ts';
import { localEvents, localRoomPath } from '../src/local-room.ts';
import { newRecord, saveAgent } from '../src/store.ts';

async function rejection(work: Promise<unknown>): Promise<string> {
	let message = '';
	await work.catch((error: unknown) => {
		message = String(error);
	});
	expect(message).not.toBe('');
	return message;
}

test('board decisions reach the room; failed announcements preserve the saved decision', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-board-move-'));
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = root;
	try {
		await saveAgent('lead', newRecord('Lead', root, 'codex'));
		const snapshot = await createBoardItem({
			title: 'Fix @all and @peer handling',
			owner: 'lead',
			state: 'review',
			evidence: ['Disposable workflow passed'],
		});
		const item = snapshot.items[0];
		if (!item) throw new Error('Missing fixture card.');
		await moveBoard(item.id, item.revision, 'approve');
		const events = await localEvents();
		expect(events).toHaveLength(1);
		expect(events[0]?.text).toBe(
			`@lead accepted completed work: Fix all and peer handling (board ${item.id})`,
		);
		expect(events[0]?.sender).toEqual({ kind: 'cli', id: 'CLI' });
		expect((await readBoard()).items[0]?.state).toBe('done');
		expect((await boardHistory(item.id)).at(-1)?.actor).toEqual({
			kind: 'operator',
			id: 'operator',
		});
		expect(await rejection(moveBoard(item.id, 1, 'approve'))).toContain('changed');
		expect(await localEvents()).toHaveLength(1);
		await moveBoard(item.id, 2, 'backlog');
		expect(await localEvents()).toHaveLength(1);

		const blocked = await createBoardItem({
			title: 'Pending choice',
			owner: 'lead',
			state: 'blocked',
			blockedOn: { kind: 'human', target: 'operator', reason: 'Decision' },
		});
		const waiting = blocked.items.find((card) => card.title === 'Pending choice');
		if (!waiting) throw new Error('Missing blocked card.');
		await moveBoard(waiting.id, 1, 'unblock');
		expect((await localEvents()).at(-1)?.text).toContain('@lead go ahead: Pending choice');
		expect(
			(await readBoard()).items.find((card) => card.id === waiting.id)?.blockedOn,
		).toBeNull();
		const deferred = await createBoardItem({
			title: 'Defer blocked work',
			owner: 'lead',
			state: 'blocked',
			blockedOn: { kind: 'human', target: 'operator', reason: 'Not now' },
		});
		const defer = deferred.items.find((card) => card.title === 'Defer blocked work');
		if (!defer) throw new Error('Missing deferred card.');
		const returned = await moveBoard(defer.id, 1, 'backlog');
		expect(returned.items.find((card) => card.id === defer.id)?.state).toBe('backlog');
		expect(returned.items.find((card) => card.id === defer.id)?.blockedOn).toEqual(
			defer.blockedOn,
		);
		expect((await readBoard()).items.find((card) => card.id === defer.id)?.blockedOn).toEqual(
			defer.blockedOn,
		);
		expect((await boardHistory(defer.id)).at(-1)?.after.blockedOn).toEqual(defer.blockedOn);
		expect((await boardWork('lead')).items.some((card) => card.id === defer.id)).toBe(false);
		for (const state of ['ready', 'doing', 'review', 'done']) {
			expect(await rejection(updateBoardItem(defer.id, 2, { state }))).toContain(
				'Clear the blocker',
			);
		}
		expect(await localEvents()).toHaveLength(2);
		await moveBoard(defer.id, 2, 'unblock');
		expect(
			(await readBoard()).items.find((card) => card.id === defer.id)?.blockedOn,
		).toBeNull();
		expect((await boardWork('lead')).items.some((card) => card.id === defer.id)).toBe(true);
		expect(await localEvents()).toHaveLength(3);

		// The board write succeeds while the independent room store is unreadable as JSON.
		await mkdir(join(root, 'room'), { recursive: true });
		await writeFile(localRoomPath(), 'invalid room fixture');
		const failure = await rejection(moveBoard(item.id, 3, 'approve'));
		expect(failure).toContain('Board decision saved (done)');
		expect(failure).toContain('Chat notification failed');
		expect(failure).toContain('Do not repeat');
		expect((await readBoard()).items[0]?.state).toBe('done');
		await writeFile(localRoomPath(), JSON.stringify(events));
		await moveBoard(item.id, 4, 'archive');
		expect(await localEvents()).toHaveLength(1);
		expect(await rejection(moveBoard(item.id, 5, 'unknown'))).toContain('Invalid board move');
		expect(await rejection(moveBoard(item.id, '5', 'backlog'))).toContain(
			'Invalid item revision',
		);
		await setCommunicationPause(true);
		expect(await rejection(moveBoard(waiting.id, 2, 'backlog'))).toContain('paused');
		expect((await readBoard()).items.find((card) => card.id === waiting.id)?.state).toBe(
			'ready',
		);
		await setCommunicationPause(false);
		await mkdir(join(root, 'integrations'), { recursive: true });
		await writeFile(
			join(root, 'integrations', 'telegram.json'),
			JSON.stringify({ botToken: '123:fixture', chatId: '456' }),
		);
		const failedPoll = spyOn(globalThis, 'fetch').mockRejectedValue(
			new Error('Fixture outage'),
		);
		try {
			await moveBoard(waiting.id, 2, 'approve');
			expect((await readBoard()).items.find((card) => card.id === waiting.id)?.state).toBe(
				'done',
			);
			expect((await localEvents()).at(-1)?.text).toContain(
				'@lead accepted completed work: Pending choice',
			);
		} finally {
			failedPoll.mockRestore();
		}
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test('the operator moves an owned, unblocked Backlog card to Ready and the owner is told', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-board-promote-'));
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = root;
	try {
		await saveAgent('lead', newRecord('Lead', root, 'codex'));
		const card = async (fields: Record<string, unknown>) => {
			const snapshot = await createBoardItem(fields);
			const item = snapshot.items.find((entry) => entry.title === fields['title']);
			if (!item) throw new Error('Missing fixture card.');
			return item;
		};
		const plain = await card({ title: 'Queued work', owner: 'lead', state: 'backlog' });
		const moved = await moveBoard(plain.id, plain.revision, 'promote');
		expect(moved.items.find((entry) => entry.id === plain.id)?.state).toBe('ready');
		expect((await localEvents()).at(-1)?.text).toBe(
			`@lead go ahead: Queued work (board ${plain.id})`,
		);
		expect((await boardHistory(plain.id)).at(-1)?.actor).toEqual({
			kind: 'operator',
			id: 'operator',
		});
		// A stale revision saves nothing and says nothing.
		expect(await rejection(moveBoard(plain.id, plain.revision, 'promote'))).toContain(
			'changed',
		);
		expect(await localEvents()).toHaveLength(1);

		// A blocker is not cleared by promotion: that is Allow work, and only for a human blocker.
		const waiting = await card({
			title: 'Waiting work',
			owner: 'lead',
			state: 'backlog',
			blockedOn: { kind: 'external', target: 'vendor', reason: 'Delivery' },
		});
		expect(await rejection(moveBoard(waiting.id, waiting.revision, 'promote'))).toContain(
			'Clear the blocker',
		);
		// No owner, no start.
		const unowned = await card({ title: 'Nobody yet', state: 'backlog' });
		expect(await rejection(moveBoard(unowned.id, unowned.revision, 'promote'))).toContain(
			'Assign an owner',
		);
		expect(await localEvents()).toHaveLength(1);
		const board = await readBoard();
		expect(board.items.find((entry) => entry.id === waiting.id)?.state).toBe('backlog');
		expect(board.items.find((entry) => entry.id === unowned.id)?.state).toBe('backlog');
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test('the operator changes a card owner; only a startable card produces a room notice', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-board-owner-'));
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = root;
	try {
		await saveAgent('lead', newRecord('Lead', root, 'codex'));
		await saveAgent('second', newRecord('Second', root, 'claude'));
		const first = await createBoardItem({
			title: 'Parked @all',
			owner: 'lead',
			state: 'backlog',
		});
		const parked = first.items[0];
		if (!parked) throw new Error('Missing fixture card.');
		const given = await ownBoard(parked.id, parked.revision, 'second');
		expect(given.items[0]?.owner).toBe('second');
		expect(given.items[0]?.state).toBe('backlog');
		expect(await localEvents()).toHaveLength(0);
		expect((await boardHistory(parked.id)).at(-1)?.actor).toEqual({
			kind: 'operator',
			id: 'operator',
		});

		// Now startable: both are told in one notice, so the one who had it stops. The title's own
		// mentions are removed.
		await moveBoard(parked.id, 2, 'promote');
		expect(await localEvents()).toHaveLength(1);
		await ownBoard(parked.id, 3, 'lead');
		const events = await localEvents();
		expect(events).toHaveLength(2);
		expect(events.at(-1)?.text).toBe(
			`@lead @second this card is now lead's, no longer second's: Parked all (board ${parked.id})`,
		);
		expect(events.at(-1)?.sender).toEqual({ kind: 'cli', id: 'CLI' });

		expect(await rejection(ownBoard(parked.id, 3, 'second'))).toContain('changed');
		expect(await rejection(ownBoard(parked.id, 4, 'nobody'))).toContain('registered teammate');
		expect(await rejection(ownBoard(parked.id, 4, ''))).toContain('Invalid board owner');
		expect(await rejection(ownBoard(parked.id, '4', 'second'))).toContain(
			'Invalid item revision',
		);
		expect((await readBoard()).items[0]?.owner).toBe('lead');
		expect(await localEvents()).toHaveLength(2);

		// What the window never offers is refused here too, and nothing is saved or said.
		expect(await rejection(ownBoard(parked.id, 4, 'lead'))).toContain('already owns');
		expect(await rejection(moveBoard(parked.id, 4, 'promote'))).toContain(
			'Only a Backlog card',
		);
		await updateBoardItem(parked.id, 4, { state: 'done', evidence: ['Fixture'] });
		expect(await rejection(ownBoard(parked.id, 5, 'second'))).toContain('keeps its owner');
		const after = (await readBoard()).items[0];
		expect([after?.owner, after?.state, after?.revision]).toEqual(['lead', 'done', 5]);
		expect(await localEvents()).toHaveLength(2);

		// A Ready card changing hands tells both teammates as well.
		const loose = await createBoardItem({ title: 'Loose end', owner: 'lead', state: 'ready' });
		const end = loose.items.find((entry) => entry.title === 'Loose end');
		if (!end) throw new Error('Missing fixture card.');
		await ownBoard(end.id, end.revision, 'second');
		expect((await localEvents()).at(-1)?.text).toBe(
			`@second @lead this card is now second's, no longer lead's: Loose end (board ${end.id})`,
		);
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await rm(root, { recursive: true, force: true });
	}
});
