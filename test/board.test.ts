import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import {
	addBoardComment,
	boardHistory,
	createBoardItem,
	readBoard,
	updateBoardItem,
} from '../src/board.ts';
import { setCommunicationPause } from '../src/communication-state.ts';
import { newRecord, saveAgent } from '../src/store.ts';

/** Indexed access that fails the test with a useful message instead of asserting non-null. */
const at = <T>(list: readonly T[], index: number): T => {
	const value = list[index];
	if (value === undefined) throw new Error(`Expected an item at index ${index}.`);
	return value;
};
/**
 * Assert a call rejects, and optionally that its message says why.
 *
 * `expect(...).rejects` is not typed as a Thenable here, so the repository's await/catch pattern is
 * used instead. A resolved call leaves the message undefined and fails, which keeps this from
 * passing vacuously when the rejection it is checking for stops happening.
 */
const rejected = async (work: Promise<unknown>, text = ''): Promise<void> => {
	let message: string | undefined;
	await work.catch((error: unknown) => {
		message = String(error);
	});
	expect(message).toBeDefined();
	if (text) expect(message).toContain(text);
};

test('board preserves state and attributed history, rejects stale edits and impossible blockers', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-board-'));
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = root;
	try {
		await saveAgent('lead', newRecord('Lead', root, 'codex'));
		await saveAgent('backup', newRecord('Backup', root, 'claude'));
		expect(await readBoard()).toEqual({ revision: 0, items: [] });
		const first = await createBoardItem({
			title: 'Verify cold restore',
			owner: 'lead',
			partner: 'backup',
		});
		const item = at(first.items, 0);
		expect(item.revision).toBe(1);
		const competing = await Promise.allSettled([
			updateBoardItem(item.id, 1, { state: 'doing' }),
			updateBoardItem(item.id, 1, { state: 'ready' }),
		]);
		expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(competing.filter((result) => result.status === 'rejected')).toHaveLength(1);
		await rejected(updateBoardItem(item.id, 2, { state: 'blocked' }), 'blocker');
		// Done-without-evidence is no longer a rejection for the operator; it has its own test below.
		await rejected(updateBoardItem(item.id, 2, { owner: 'missing' }), 'registered');
		await rejected(updateBoardItem(item.id, 2, { partner: 'lead' }), 'differ');
		await rejected(updateBoardItem(item.id, 2, { revision: 999 }));
		await rejected(
			updateBoardItem(item.id, 2, {
				state: 'blocked',
				blockedOn: { kind: 'task', target: item.id, reason: 'self' },
			}),
			'cycle',
		);
		const other = at(
			(await createBoardItem({ title: 'Review restore', owner: 'backup' })).items,
			1,
		);
		await updateBoardItem(item.id, 2, {
			state: 'blocked',
			blockedOn: { kind: 'task', target: other.id, reason: 'Needs review' },
		});
		await rejected(
			updateBoardItem(other.id, 1, {
				state: 'blocked',
				blockedOn: { kind: 'task', target: item.id, reason: 'Circular' },
			}),
			'cycle',
		);
		await updateBoardItem(item.id, 3, {
			state: 'done',
			blockedOn: null,
			evidence: ['room:1099; isolated restore passed'],
		});
		const history = await boardHistory(item.id);
		expect(history).toHaveLength(4);
		expect(history[0]?.before).toBeNull();
		expect(history.at(-1)?.before?.state).toBe('blocked');
		expect(history.at(-1)?.after.state).toBe('done');
		expect(history.at(-1)?.actor).toEqual({ kind: 'operator', id: 'operator' });
		expect((await readBoard()).items[0]?.revision).toBe(4);
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test('board binds agent writes to current launch and owner, and respects halt without losing reads', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-board-identity-'));
	const prior = {
		home: process.env.SUMMON_HOME,
		agent: process.env.SUMMON_AGENT,
		nonce: process.env.SUMMON_NONCE,
	};
	process.env.SUMMON_HOME = root;
	try {
		await saveAgent('lead', newRecord('Lead', root, 'codex'));
		await saveAgent('peer', newRecord('Peer', root, 'claude'));
		await initializeActivity('lead', 'launch-one');
		const peerItem = at(
			(await createBoardItem({ title: 'Peer task', owner: 'peer' })).items,
			0,
		);
		process.env.SUMMON_AGENT = 'lead';
		process.env.SUMMON_NONCE = 'launch-one';
		const own = at((await createBoardItem({ title: 'Own task' })).items, 1);
		expect(own.owner).toBe('lead');
		await rejected(updateBoardItem(peerItem.id, 1, { title: 'Take over' }), 'own work');
		await rejected(updateBoardItem(own.id, 1, { owner: 'peer' }), 'ownership');
		await updateBoardItem(own.id, 1, { state: 'doing' });
		expect((await boardHistory(own.id)).at(-1)?.actor).toEqual({ kind: 'agent', id: 'lead' });
		process.env.SUMMON_NONCE = 'obsolete-launch';
		await rejected(
			updateBoardItem(own.id, 2, { title: 'Wrong launch' }),
			'current registered launch',
		);
		process.env.SUMMON_NONCE = 'launch-one';
		// The fixture's operator applies the pause; the agent remains bound for the Board check.
		delete process.env.SUMMON_AGENT;
		try {
			await setCommunicationPause(true);
		} finally {
			process.env.SUMMON_AGENT = 'lead';
		}
		await rejected(updateBoardItem(own.id, 2, { title: 'Halted' }), 'Halt');
		expect((await readBoard()).items[1]?.title).toBe('Own task');
	} finally {
		// Restored key by key: a loop over computed names cannot delete an environment variable
		// without a dynamic delete, and there are only three to name.
		if (prior.home === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = prior.home;
		if (prior.agent === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = prior.agent;
		if (prior.nonce === undefined) delete process.env.SUMMON_NONCE;
		else process.env.SUMMON_NONCE = prior.nonce;
		await rm(root, { recursive: true, force: true });
	}
});

test('an operator approval records itself as evidence; an agent still brings its own', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-board-approve-'));
	const prior = {
		home: process.env.SUMMON_HOME,
		agent: process.env.SUMMON_AGENT,
		nonce: process.env.SUMMON_NONCE,
	};
	process.env.SUMMON_HOME = root;
	try {
		await saveAgent('lead', newRecord('Lead', root, 'codex'));
		const card = at(
			(await createBoardItem({ title: 'Verify restore', owner: 'lead' })).items,
			0,
		);
		// Creating straight into done has no revision to have been looking at, so the rule holds.
		await rejected(
			createBoardItem({ title: 'No provenance', owner: 'lead', state: 'done' }),
			'evidence',
		);
		await updateBoardItem(card.id, 1, { state: 'review' });
		const approved = at((await updateBoardItem(card.id, 2, { state: 'done' })).items, 0);
		// The approval is its own evidence, and it names the revision that was on screen.
		expect(approved.evidence).toHaveLength(1);
		expect(approved.evidence[0]).toContain('Operator approved revision 2 on the board at');
		expect((await boardHistory(card.id)).at(-1)?.actor).toEqual({
			kind: 'operator',
			id: 'operator',
		});
		// An agent gets no such courtesy: unevidenced done is still refused.
		const own = at((await createBoardItem({ title: 'Agent work', owner: 'lead' })).items, 1);
		await initializeActivity('lead', 'launch-one');
		process.env.SUMMON_AGENT = 'lead';
		process.env.SUMMON_NONCE = 'launch-one';
		await rejected(updateBoardItem(own.id, 1, { state: 'done' }), 'evidence');
	} finally {
		if (prior.home === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = prior.home;
		if (prior.agent === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = prior.agent;
		if (prior.nonce === undefined) delete process.env.SUMMON_NONCE;
		else process.env.SUMMON_NONCE = prior.nonce;
		await rm(root, { recursive: true, force: true });
	}
});

test('comments append with attribution and survive field edits; archiving leaves state alone', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-board-comments-'));
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = root;
	try {
		await saveAgent('lead', newRecord('Lead', root, 'codex'));
		const card = at(
			(await createBoardItem({ title: 'Prune movies share', owner: 'lead' })).items,
			0,
		);
		expect(card.comments).toEqual([]);
		expect(card.archived).toBe(false);
		const revision = (await readBoard()).revision;
		await addBoardComment(card.id, 'Waiting on the capacity decision.');
		expect((await readBoard()).revision).toBe(revision + 1);
		const commented = at((await readBoard()).items, 0);
		expect(commented.revision).toBe(card.revision);
		expect(commented.comments).toHaveLength(1);
		expect(commented.comments[0]?.actor).toEqual({ kind: 'operator', id: 'operator' });
		// The remark records the revision it was written against, not the one it ends up beside.
		expect(commented.comments[0]?.revision).toBe(1);
		expect(commented.comments[0]?.body).toBe('Waiting on the capacity decision.');
		await rejected(addBoardComment(card.id, '   '));
		expect((await readBoard()).revision).toBe(revision + 1);
		// A field patch cannot rewrite or drop the comments, because they are not a patchable field.
		const edited = at((await updateBoardItem(card.id, 1, { state: 'doing' })).items, 0);
		expect(edited.comments).toHaveLength(1);
		expect(edited.revision).toBe(2);
		// Archiving is orthogonal: the card keeps the state it finished in.
		const archived = at((await updateBoardItem(card.id, 2, { archived: true })).items, 0);
		expect(archived.archived).toBe(true);
		expect(archived.state).toBe('doing');
		expect(archived.comments).toHaveLength(1);
		// History records fields, not comments. The snapshots omit them by construction, so an
		// append-only log can never accumulate a second copy of every remark.
		const change = (await boardHistory(card.id)).at(-1);
		expect(change?.after).not.toHaveProperty('comments');
		expect(change?.before).not.toHaveProperty('comments');
		expect(change?.after.archived).toBe(true);
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test('a board written with comments inside its history snapshots stays readable', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-board-legacy-'));
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = root;
	try {
		await saveAgent('lead', newRecord('Lead', root, 'codex'));
		const card = at(
			(await createBoardItem({ title: 'Written earlier', owner: 'lead' })).items,
			0,
		);
		// Reproduce the shape a previous build persisted: comments copied into the change snapshots.
		const file = join(root, 'board', 'state.json');
		const document = JSON.parse(await readFile(file, 'utf8')) as {
			history: { before: unknown; after: Record<string, unknown> }[];
		};
		at(document.history, 0).after.comments = [
			{
				at: new Date().toISOString(),
				actor: { kind: 'operator', id: 'operator' },
				revision: 1,
				body: 'Written by the earlier shape.',
			},
		];
		await writeFile(file, JSON.stringify(document));
		// The board must still load, and the legacy key must not survive into the parsed history.
		expect((await readBoard()).items).toHaveLength(1);
		const change = at(await boardHistory(card.id), 0);
		expect(change.after).not.toHaveProperty('comments');
		// And the board must still be writable afterwards rather than wedged.
		await addBoardComment(card.id, 'Still accepting comments.');
		expect(at((await readBoard()).items, 0).comments).toHaveLength(1);
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await rm(root, { recursive: true, force: true });
	}
});
