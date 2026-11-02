import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cloneAgent } from '../src/clone.ts';
import { loadAgent, newRecord, notesPath, recordPath, saveAgent } from '../src/store.ts';

let home: string | undefined;
const previous = process.env.SUMMON_HOME;

afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	if (home) await rm(home, { force: true, recursive: true });
	home = undefined;
});

test('a grok clone keeps the codex memory and drops the session', async () => {
	home = await mkdtemp(join(tmpdir(), 'summon-clone-'));
	process.env.SUMMON_HOME = home;
	const source = {
		version: 3,
		name: 'Morgan',
		expertise: 'Knows the summon mailbox.',
		domain: 'Summon implementation.',
		cwd: 'D:\\applications\\summon',
		createdAt: '2026-09-24T17:55:55.567Z',
		updatedAt: '2026-09-26T18:03:15.945Z',
		provider: 'codex',
		sessions: [
			{
				id: 'codex-session',
				createdAt: '2026-09-24T18:06:13.175Z',
				lastUsedAt: '2026-09-26T18:03:15.945Z',
			},
		],
	};
	await writeFile(recordPath('morgan'), `${JSON.stringify(source, null, '\t')}\n`);
	await writeFile(notesPath('morgan'), '# Morgan\n\nThe mailbox lives under summon.\n');

	const created = await cloneAgent('Morgan', 'Emma', 'grok');
	expect(created).toEqual({ slug: 'emma', provider: 'grok' });

	const emma = await loadAgent('emma');
	expect(emma?.name).toBe('Emma');
	expect(emma?.provider).toBe('grok');
	expect(emma?.sessions).toEqual([]);
	expect(emma?.domain).toBeUndefined();
	expect(emma?.cwd).toBe('D:\\applications\\summon');
	expect(emma?.expertise).toContain('Emma is a grok clone of Morgan');
	expect(emma?.expertise).toContain('Knows the summon mailbox.');
	expect(emma?.expertise).not.toContain('codex-session');

	const notes = await readFile(notesPath('emma'), 'utf8');
	expect(notes).toContain('# Morgan');
	expect(notes).toContain('The mailbox lives under summon.');
	expect(
		notes
			.trimEnd()
			.endsWith(
				'Domain authority was not copied. Morgan remains the primary unless the user assigns it.',
			),
	).toBe(true);
	expect(notes).toContain('You are Emma, not Morgan.');
	expect(notes).toContain('Summon implementation.');

	const morgan = await loadAgent('morgan');
	expect(morgan?.sessions[0]?.id).toBe('codex-session');
	expect(morgan?.provider).toBe('codex');
});

test('refuses to clone onto an existing name', async () => {
	home = await mkdtemp(join(tmpdir(), 'summon-clone-'));
	process.env.SUMMON_HOME = home;
	const record = {
		version: 3,
		name: 'Morgan',
		expertise: 'Knows summon.',
		cwd: 'D:\\applications\\summon',
		createdAt: '2026-09-24T17:55:55.567Z',
		updatedAt: '2026-09-24T17:55:55.567Z',
		provider: 'codex',
		sessions: [],
	};
	await writeFile(recordPath('morgan'), `${JSON.stringify(record)}\n`);
	await writeFile(
		recordPath('emma'),
		`${JSON.stringify({ ...record, name: 'Emma', provider: 'grok' })}\n`,
	);
	let rejected = false;
	try {
		await cloneAgent('Morgan', 'Emma', 'grok');
	} catch (error: unknown) {
		rejected = error instanceof Error && error.message.includes('already registered');
	}
	expect(rejected).toBe(true);
});

test('a full expertise profile clones within the editable limit without changing its source', async () => {
	home = await mkdtemp(join(tmpdir(), 'summon-clone-'));
	process.env.SUMMON_HOME = home;
	const source = newRecord('Source', home, 'codex');
	source.expertise = 'x'.repeat(8000);
	await saveAgent('source', source);
	await cloneAgent('Source', 'Copy');
	const copy = await loadAgent('copy');
	expect(copy?.expertise.length).toBe(8000);
	expect(copy?.expertise.startsWith('Copy is a codex clone of Source')).toBe(true);
	expect(copy?.expertise.endsWith('…')).toBe(true);
	expect((await loadAgent('source'))?.expertise).toBe(source.expertise);
});
