import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { createBoardItem } from '../src/board.ts';
import { setCommunicationPause } from '../src/communication-state.ts';
import { addDiary, readDiary } from '../src/diary.ts';
import { appendLocalEvent } from '../src/local-room.ts';
import { newRecord, saveAgent } from '../src/store.ts';

async function fixture(work: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'summon-diary-'));
	const previous = {
		home: process.env.SUMMON_HOME,
		agent: process.env.SUMMON_AGENT,
		nonce: process.env.SUMMON_NONCE,
	};
	process.env.SUMMON_HOME = root;
	delete process.env.SUMMON_AGENT;
	delete process.env.SUMMON_NONCE;
	try {
		await work(root);
	} finally {
		if (previous.home === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous.home;
		if (previous.agent === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = previous.agent;
		if (previous.nonce === undefined) delete process.env.SUMMON_NONCE;
		else process.env.SUMMON_NONCE = previous.nonce;
		await rm(root, { recursive: true, force: true });
	}
}

async function rejected(work: Promise<unknown>, text: string): Promise<void> {
	let error: string | undefined;
	await work.catch((value: unknown) => {
		error = String(value);
	});
	expect(error).toContain(text);
}

test('diary retains concurrent entries, stable older pages and verified links', async () =>
	fixture(async (root) => {
		expect(await readDiary()).toEqual({ entries: [], next: null });
		await saveAgent('lead', newRecord('Lead', root, 'codex'));
		const card = (await createBoardItem({ title: 'Deliver fixture', owner: 'lead' })).items[0];
		if (!card) throw new Error('Missing fixture card.');
		const room = await appendLocalEvent({
			sender: { kind: 'user', id: 'operator' },
			text: 'Approved fixture',
			replyTo: null,
			source: 'local',
		});
		const linked = await addDiary({
			for: 'Phillip',
			task: 'Delivered fixture',
			room: [room.id],
			board: [card.id],
		});
		expect(linked.author).toEqual({ kind: 'operator', id: 'operator' });
		expect(linked.room).toEqual([room.id]);
		expect(linked.board).toEqual([card.id]);
		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				addDiary({ for: 'Lead', task: `Notable result ${index}` }),
			),
		);
		expect((await readDiary()).entries).toHaveLength(13);
		const documentPath = join(root, 'diary', 'entries.json');
		const raw: unknown = JSON.parse(await readFile(documentPath, 'utf8'));
		if (!raw || typeof raw !== 'object' || !('entries' in raw) || !Array.isArray(raw.entries))
			throw new Error('Invalid fixture.');
		// Extend genuine entries to exercise pagination without 100 filesystem writes.
		const base = linked;
		const expanded = Array.from({ length: 105 }, (_, index) => ({
			...base,
			id: crypto.randomUUID(),
			at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
		}));
		await writeFile(documentPath, JSON.stringify({ version: 1, entries: expanded }));
		const first = await readDiary();
		expect(first.entries).toHaveLength(100);
		expect(first.entries[0]?.at).toBe(expanded.at(-1)?.at);
		if (!first.next) throw new Error('Expected older cursor.');
		await addDiary({ for: 'Phillip', task: 'New work while reading' });
		const older = await readDiary(first.next);
		expect(older.entries).toHaveLength(5);
		expect(older.next).toBeNull();
		expect(
			older.entries.every((entry) => !first.entries.some((seen) => seen.id === entry.id)),
		).toBe(true);
		await rejected(readDiary(crypto.randomUUID()), 'cursor not found');
		await rejected(
			addDiary({ for: 'Phillip', task: 'Missing evidence', room: [999] }),
			'message not found',
		);
		await rejected(
			addDiary({ for: 'Phillip', task: 'Missing card', board: [crypto.randomUUID()] }),
			'card not found',
		);
	}));

test('diary rejects spoofed authors, stale launches, invalid input and communication holds', async () =>
	fixture(async (root) => {
		await rejected(
			addDiary({ for: 'Phillip', task: 'Spoofed', author: { kind: 'agent', id: 'peer' } }),
			'Unrecognized',
		);
		await rejected(addDiary({ for: 'Phillip', task: ' '.repeat(5) }), 'Too small');
		await saveAgent('lead', newRecord('Lead', root, 'codex'));
		await initializeActivity('lead', 'launch-one');
		process.env.SUMMON_AGENT = 'lead';
		await rejected(
			addDiary({ for: 'Phillip', task: 'Missing launch token' }),
			'named summon session',
		);
		process.env.SUMMON_NONCE = 'stale';
		await rejected(addDiary({ for: 'Phillip', task: 'Wrong launch' }), 'registered launch');
		process.env.SUMMON_NONCE = 'launch-one';
		const item = await addDiary({
			for: 'Phillip',
			task: '<img onerror=alert(1)> literal task',
		});
		expect(item.author).toEqual({ kind: 'agent', id: 'lead' });
		delete process.env.SUMMON_AGENT;
		try {
			await setCommunicationPause(true);
		} finally {
			process.env.SUMMON_AGENT = 'lead';
		}
		await rejected(addDiary({ for: 'Phillip', task: 'Held write' }), 'paused');
		expect((await readDiary()).entries).toHaveLength(1);
	}));

test('Diary search covers authors and older messages while retaining matching page cursors', async () =>
	fixture(async (root) => {
		const base = await addDiary({ for: 'recipient-only', task: 'Seed' });
		const saved = Array.from({ length: 206 }, (_, index) => ({
			...base,
			id: crypto.randomUUID(),
			author: { kind: 'agent' as const, id: 'author-only' },
			at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
			task: index === 0 ? 'Oldest-only [literal]' : `Release message ${index}`,
		}));
		await writeFile(
			join(root, 'diary', 'entries.json'),
			JSON.stringify({ version: 1, entries: saved }),
		);
		expect((await readDiary()).entries).toHaveLength(100);
		expect((await readDiary(undefined, ' OLDEST-ONLY ')).entries[0]?.id).toBe(saved[0]?.id);
		expect((await readDiary(undefined, '[literal]')).entries).toHaveLength(1);
		const authorPage = await readDiary(undefined, ' AUTHOR-ONLY ');
		expect(authorPage.entries).toHaveLength(100);
		if (!authorPage.next) throw new Error('Missing author search cursor.');
		const authorSecond = await readDiary(authorPage.next, 'author-only');
		expect(authorSecond.entries).toHaveLength(100);
		if (!authorSecond.next) throw new Error('Missing second author search cursor.');
		const authorThird = await readDiary(authorSecond.next, 'author-only');
		expect(authorThird.entries).toHaveLength(6);
		expect(authorThird.next).toBeNull();
		expect(
			new Set(
				[...authorPage.entries, ...authorSecond.entries, ...authorThird.entries].map(
					(e) => e.id,
				),
			).size,
		).toBe(206);
		expect((await readDiary(undefined, 'thor-on')).entries).toHaveLength(100);
		for (const query of ['recipient-only', '2026-01-01', '.*'])
			expect(await readDiary(undefined, query)).toEqual({ entries: [], next: null });
		const first = await readDiary(undefined, 'release');
		expect(first.entries).toHaveLength(100);
		if (!first.next) throw new Error('Missing search cursor.');
		await addDiary({ for: 'Phillip', task: 'Release arrived during search' });
		const second = await readDiary(first.next, 'release');
		expect(second.entries).toHaveLength(100);
		if (!second.next) throw new Error('Missing second search cursor.');
		const third = await readDiary(second.next, 'release');
		expect(third.entries).toHaveLength(5);
		expect(third.next).toBeNull();
		expect(
			new Set([...first.entries, ...second.entries, ...third.entries].map((e) => e.id)).size,
		).toBe(205);
		await rejected(readDiary(undefined, 'x'.repeat(301)), 'Too big');
		await rejected(readDiary(undefined, 5), 'Invalid');
	}));

test('author and message matches form one literal read-only result set', async () =>
	fixture(async (root) => {
		const base = await addDiary({ for: 'morgan', task: 'Seed' });
		const saved = [
			{ author: 'morgan', task: 'Completed the storage audit' },
			{ author: 'alice', task: 'Reviewed Morgan contribution' },
			{ author: 'morgan', task: 'Morgan completed the gate' },
			{ author: 'dave', task: 'Completed unrelated work' },
		].map((entry, index) => ({
			...base,
			id: crypto.randomUUID(),
			at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
			author: { kind: 'agent' as const, id: entry.author },
			task: entry.task,
		}));
		const path = join(root, 'diary', 'entries.json');
		const before = JSON.stringify({ version: 1, entries: saved });
		await writeFile(path, before);
		const found = await readDiary(undefined, ' MoRGaN ');
		expect(found.entries.map((entry) => entry.id)).toEqual(
			saved
				.slice(0, 3)
				.reverse()
				.map((entry) => entry.id),
		);
		expect(found.next).toBeNull();
		expect(await readDiary(undefined, '.*')).toEqual({ entries: [], next: null });
		expect(await readFile(path, 'utf8')).toBe(before);
	}));
