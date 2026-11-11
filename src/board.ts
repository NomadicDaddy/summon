import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
	BoardChange,
	BoardDocument,
	BoardFields,
	BoardItem,
	BoardSnapshot,
	BoardWork,
} from './board-model.ts';

import { readActivity, withActiveSeatWrite } from './agent-activity.ts';
import { archivedBoardHistory, completeBoardHistory, rotateBoardHistory } from './board-history.ts';
import {
	boardCommentSchema,
	boardDocumentSchema,
	boardFields,
	boardSnapshotSchema,
} from './board-model.ts';
import { communicationSend } from './communication-gate.ts';
import { atomicWrite, locked, missing, optionalText } from './mail-files.ts';
import { currentAgent, messageId } from './mail-identity.ts';
import { roomCache } from './room-cache.ts';
import { loadAgent, slugFor, storageRoot } from './store.ts';

const boardPath = (): string => join(storageRoot(), 'board', 'state.json');
const MAX_BYTES = 16 * 1024 * 1024;
const cachedSnapshot = roomCache<BoardSnapshot>();

/**
 * Drop a `comments` key from history snapshots written before the snapshot shape excluded it.
 *
 * History briefly copied each card's comments into its before/after snapshots. Those entries are
 * already on disk and the snapshot schema is strict, so they have to be tolerated on read rather
 * than rejected — refusing them would make an existing board unreadable. Removing the key loses
 * nothing, because the comments themselves live on the card. The next write persists the normalised
 * form, so this only ever runs against a file written by the earlier shape.
 * @param value The parsed document, before validation.
 * @returns The same value with legacy snapshot keys removed.
 */
function withoutLegacySnapshotKeys(value: unknown): unknown {
	const history = (value as { history?: unknown } | null)?.history;
	if (!Array.isArray(history)) return value;
	for (const change of history) {
		if (!change || typeof change !== 'object') continue;
		for (const side of ['before', 'after'] as const) {
			const snapshot = (change as Record<string, unknown>)[side];
			if (snapshot && typeof snapshot === 'object')
				delete (snapshot as Record<string, unknown>).comments;
		}
	}
	return value;
}
async function document(): Promise<BoardDocument> {
	const info = await stat(boardPath()).catch((error: unknown) => {
		if (!missing(error)) throw error;
		return undefined;
	});
	if (info && info.size > MAX_BYTES) throw new Error('Board storage exceeds its safety limit.');
	const raw = await optionalText(boardPath());
	if (!raw) return { version: 1, revision: 0, items: [], history: [] };
	return boardDocumentSchema.parse(withoutLegacySnapshotKeys(JSON.parse(raw) as unknown));
}

export async function readBoard(): Promise<BoardSnapshot> {
	return structuredClone(
		await cachedSnapshot(boardPath(), async () => {
			const data = await document();
			return { revision: data.revision, items: data.items };
		}),
	);
}

/**
 * What one teammate could pick up right now, and nothing else.
 *
 * This exists because the whole board is the wrong question to ask when the only thing a session
 * needs to know is whether it has work. `readBoard` returns every card with its description and
 * evidence, which is over 100 KB on a live board, so a session that consulted it whenever it went
 * idle would spend more doing that than on the polling it was meant to replace. A caught-up session
 * with no affordable way to ask what it should be doing has one action available to it, and it takes
 * it repeatedly: that is the loop that emptied two sessions into nothing but checkpoints.
 *
 * `doing` comes before `ready` so a session resumes what it already started rather than opening
 * something new beside it. Only those two lanes appear. `backlog` is undecided, `blocked` cannot
 * proceed by definition, `review` is waiting on somebody else, and `done` is over; none of them is
 * an answer to "what should I work on", and including them would put the session back in the
 * position of having to read everything to find out.
 *
 * Titles only. Picking a card and understanding it are different questions, and the second one has
 * `list` and `history` for the single card that was chosen.
 */
export async function boardWork(name?: string): Promise<BoardWork> {
	const owner = name === undefined ? currentAgent() : slugFor(name);
	if (!owner) throw new Error('Name whose work to list, or run this from a launched session.');
	const lanes: BoardItem['state'][] = ['doing', 'ready'];
	const items = (await document()).items
		.filter((item) => item.owner === owner && !item.archived && lanes.includes(item.state))
		.sort((left, right) => lanes.indexOf(left.state) - lanes.indexOf(right.state))
		.map((item) => ({
			id: item.id,
			project: item.project,
			state: item.state,
			title: item.title,
			...(item.partner ? { partner: item.partner } : {}),
		}));
	return { owner, items };
}

export async function boardHistory(id: string): Promise<BoardChange[]> {
	messageId(id);
	return locked(`${boardPath()}.lock`, async () => {
		const live = (await document()).history.filter((change) => change.itemId === id);
		return completeBoardHistory([...(await archivedBoardHistory(id)), ...live]);
	});
}

async function actor(): Promise<BoardChange['actor']> {
	if (!process.env.SUMMON_AGENT) return { kind: 'operator', id: 'operator' };
	const id = currentAgent();
	if (!(await loadAgent(id)) || (await readActivity(id))?.nonce !== process.env.SUMMON_NONCE)
		throw new Error('Board updates require the current registered launch.');
	return { kind: 'agent', id };
}

async function validateLinks(item: BoardFields, items: BoardItem[], id: string): Promise<void> {
	for (const name of [item.owner, item.partner])
		if (name && !(await loadAgent(name))) throw new Error('Choose a registered teammate.');
	if (item.partner && item.partner === item.owner)
		throw new Error('Owner and partner must differ.');
	if (item.state !== 'backlog' && !item.owner)
		throw new Error('Assign an owner before starting work.');
	if (item.state === 'blocked' && !item.blockedOn)
		throw new Error('Blocked work needs a blocker.');
	if (item.state !== 'blocked' && item.state !== 'backlog' && item.blockedOn)
		throw new Error('Clear the blocker when changing state.');
	if (item.state === 'done' && item.evidence.length === 0)
		throw new Error('Done work needs completion evidence.');
	if (item.blockedOn?.kind === 'agent' && !(await loadAgent(item.blockedOn.target)))
		throw new Error('Choose a registered blocking teammate.');
	if (item.blockedOn?.kind === 'task') {
		let target: string | undefined = item.blockedOn.target;
		const seen = new Set([id]);
		while (target) {
			if (seen.has(target)) throw new Error('Task blockers cannot form a cycle.');
			seen.add(target);
			const task = items.find((candidate) => candidate.id === target);
			if (!task) throw new Error('Blocking task does not exist.');
			target = task.blockedOn?.kind === 'task' ? task.blockedOn.target : undefined;
		}
	}
}

async function mutate(id: string | null, revision: number, value: unknown): Promise<BoardSnapshot> {
	const who = await actor();
	return communicationSend('save the Board change', () =>
		locked(`${boardPath()}.lock`, () =>
			withActiveSeatWrite(async () => {
				const data = await document();
				await rotateBoardHistory(data);
				const before = id ? data.items.find((item) => item.id === id) : undefined;
				if (id && !before) throw new Error('Board item not found.');
				if (before && before.revision !== revision)
					throw new Error('Board item changed; reload before saving.');
				const patch = boardFields.partial().parse(value);
				const fields = boardFields.parse({
					project: '',
					owner: who.kind === 'agent' ? who.id : '',
					partner: '',
					description: '',
					state: 'backlog',
					blockedOn: null,
					evidence: [],
					archived: false,
					...(before ? boardFields.strip().parse(before) : {}),
					...patch,
				});
				if (
					who.kind === 'agent' &&
					((before && before.owner !== who.id) || fields.owner !== who.id)
				)
					throw new Error(
						'Agents may update only their own work; ownership changes require the operator.',
					);
				const itemId = id ?? randomUUID();
				const at = new Date().toISOString();
				// Approving a card from the board supplies no evidence, and the rule that done is never a
				// bare assertion is worth keeping rather than carving an exception into. Record the
				// approval itself, naming the revision that was on screen, so what was approved stays
				// recoverable from history. Agents still have to bring their own evidence.
				if (
					who.kind === 'operator' &&
					before &&
					fields.state === 'done' &&
					fields.evidence.length === 0
				)
					fields.evidence = [
						`Operator approved revision ${before.revision} on the board at ${at}.`,
					];
				await validateLinks(fields, data.items, itemId);
				const after: BoardItem = {
					...fields,
					id: itemId,
					revision: (before?.revision ?? 0) + 1,
					createdAt: before?.createdAt ?? at,
					updatedAt: at,
					comments: before?.comments ?? [],
				};
				if (before) data.items[data.items.indexOf(before)] = after;
				else data.items.push(after);
				data.revision++;
				const snapshot = (item: BoardItem): BoardChange['after'] =>
					boardSnapshotSchema.strip().parse(item);
				data.history.push({
					at,
					actor: who,
					itemId,
					before: before ? snapshot(before) : null,
					after: snapshot(after),
				});
				boardDocumentSchema.parse(data);
				const serialized = JSON.stringify(data);
				if (Buffer.byteLength(serialized) > MAX_BYTES)
					throw new Error('Board storage limit reached; history was not discarded.');
				await atomicWrite(boardPath(), serialized);
				return { revision: data.revision, items: data.items };
			}),
		),
	);
}

/**
 * Append a remark to a card.
 *
 * Deliberately takes no expected revision. Comments are appends, so two written at once do not
 * conflict and neither should be refused for a view that moved underneath it; a field edit is the
 * only thing that needs optimistic concurrency. The card's current revision is stored on the remark
 * instead, which is what says the comment was about.
 * @param id The card to comment on.
 * @param body The remark.
 * @returns The board after the append.
 */
export async function addBoardComment(id: string, body: unknown): Promise<BoardSnapshot> {
	messageId(id);
	const who = await actor();
	return communicationSend('add the Board comment', () =>
		locked(`${boardPath()}.lock`, () =>
			withActiveSeatWrite(async () => {
				const data = await document();
				await rotateBoardHistory(data);
				const item = data.items.find((candidate) => candidate.id === id);
				if (!item) throw new Error('Board item not found.');
				item.comments.push(
					boardCommentSchema.parse({
						at: new Date().toISOString(),
						actor: who,
						revision: item.revision,
						body,
					}),
				);
				data.revision++;
				boardDocumentSchema.parse(data);
				const serialized = JSON.stringify(data);
				if (Buffer.byteLength(serialized) > MAX_BYTES)
					throw new Error('Board storage limit reached; the comment was not added.');
				await atomicWrite(boardPath(), serialized);
				return { revision: data.revision, items: data.items };
			}),
		),
	);
}

export const createBoardItem = (value: unknown): Promise<BoardSnapshot> => mutate(null, 0, value);
export async function updateBoardItem(
	id: string,
	expectedRevision: number,
	patch: unknown,
): Promise<BoardSnapshot> {
	messageId(id);
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
		throw new Error('Invalid item revision.');
	return mutate(id, expectedRevision, patch);
}
