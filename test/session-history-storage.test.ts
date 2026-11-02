import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sessionTransitions } from '../src/desktop/session-transitions.ts';
import { missing } from '../src/mail-files.ts';
import {
	appendSessionTransition,
	readSessionHistory,
	SESSION_HISTORY_LIMIT,
} from '../src/session-history.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});
const event = () => ({
	member: 'alpha',
	provider: 'codex' as const,
	nonce: randomUUID(),
	state: 'started' as const,
	reason: 'operator' as const,
});
async function refused(task: Promise<unknown>, reason: string): Promise<void> {
	const error: unknown = await task.catch((value: unknown) => value);
	expect(error).toBeInstanceOf(Error);
	if (!(error instanceof Error)) throw new Error('Missing refusal');
	expect(error.message).toContain(reason);
}

test('queued lifecycle evidence stays in its originating root after a process environment switch', async () => {
	const root = fixture.records;
	const other = join(fixture.root, 'other-team');
	await mkdir(other);
	let failures = 0;
	const journal = sessionTransitions(new Date().toISOString(), () => {
		failures++;
	});
	const saved = journal.recordSession(
		{
			agent: {
				slug: 'alpha',
				name: 'Alpha',
				cwd: fixture.root,
				provider: 'codex',
				status: 'running',
			},
			launch: { nonce: randomUUID(), since: new Date().toISOString() },
			pty: { pid: 1 },
		},
		'started',
		'operator',
	);
	process.env.SUMMON_HOME = other;
	await saved;
	await journal.flush();
	expect((await readSessionHistory({ limit: 1 })).entries).toHaveLength(0);
	process.env.SUMMON_HOME = root;
	expect((await readSessionHistory({ limit: 1 })).entries[0]?.member).toBe('alpha');
	expect(failures).toBe(0);
});

test('retention is bounded and pagination discloses omitted transitions', async () => {
	await appendSessionTransition(event(), new Date().toISOString(), fixture.records);
	const path = join(fixture.records, 'logs/session-history.json');
	const initial = JSON.parse(await readFile(path, 'utf8')) as { entries: object[] };
	const first = initial.entries[0];
	if (!first) throw new Error('Positive control missing');
	const seeded = Array.from({ length: SESSION_HISTORY_LIMIT }, (_, index) => ({
		...first,
		id: randomUUID(),
		nonce: randomUUID(),
		pid: index + 1,
	}));
	await writeFile(path, JSON.stringify({ version: 1, entries: seeded }));
	await appendSessionTransition(event(), new Date().toISOString(), fixture.records);
	const retained = JSON.parse(await readFile(path, 'utf8')) as { entries: { id: string }[] };
	expect(retained.entries).toHaveLength(SESSION_HISTORY_LIMIT);
	expect(retained.entries[0]?.id).toBe(seeded[1]?.id);
	const view = await readSessionHistory({ limit: 2 });
	expect(view.more).toBe(true);
	expect(view.entries).toHaveLength(2);
	expect(view.retainedTransitions).toBe(SESSION_HISTORY_LIMIT);
});

test('linked files and missing originating roots refuse writes without changing evidence or recreating roots', async () => {
	await appendSessionTransition(event(), new Date().toISOString(), fixture.records);
	const path = join(fixture.records, 'logs/session-history.json');
	const bytes = await readFile(path, 'utf8');
	const linked = join(fixture.root, 'linked-history.json');
	await link(path, linked);
	await refused(
		appendSessionTransition(event(), new Date().toISOString(), fixture.records),
		'redirected',
	);
	expect(await readFile(linked, 'utf8')).toBe(bytes);
	const removed = join(fixture.root, 'removed-team');
	await mkdir(removed);
	expect((await lstat(removed)).isDirectory()).toBe(true);
	await rmdir(removed);
	await refused(appendSessionTransition(event(), new Date().toISOString(), removed), 'missing');
	const recreated = await lstat(removed).then(
		() => true,
		(error: unknown) => {
			if (missing(error)) return false;
			throw error;
		},
	);
	expect(recreated).toBe(false);
	expect(await Bun.file(linked).exists()).toBe(true);
});
