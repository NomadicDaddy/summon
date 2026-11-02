import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import {
	appendNote,
	forgetSession,
	latestSession,
	listAgentDomains,
	listAgentSlugs,
	loadAgent,
	newRecord,
	notesPath,
	readNotes,
	rememberSession,
	saveAgent,
	slugFor,
	storageRoot,
} from '../src/store.ts';

let temporaryRoot: string | undefined;
const previousRoot = process.env.SUMMON_HOME;
const previousBase = process.env.SUMMON_TEAMS_HOME;

afterEach(async () => {
	if (temporaryRoot) {
		const target = resolve(temporaryRoot);
		if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('summon-test-')) {
			throw new Error('Refusing to remove an unexpected test directory.');
		}
		await rm(target, { recursive: true, force: true });
	}
	temporaryRoot = undefined;
	if (previousRoot === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousRoot;
	if (previousBase === undefined) delete process.env.SUMMON_TEAMS_HOME;
	else process.env.SUMMON_TEAMS_HOME = previousBase;
});

async function useTemporaryStore(): Promise<string> {
	temporaryRoot = await mkdtemp(join(tmpdir(), 'summon-test-'));
	process.env.SUMMON_HOME = temporaryRoot;
	return temporaryRoot;
}

describe('agent storage', () => {
	test('enumerates canonical regular record names in stable order', async () => {
		const root = await useTemporaryStore();
		await mkdir(join(root, 'directory.json'));
		for (const name of ['zebra.json', 'alpha.json', 'bad name.json', 'all.json', 'notes.md'])
			await writeFile(join(root, name), '{}');
		expect(await listAgentSlugs()).toEqual(['alpha', 'zebra']);
	});

	test('defaults to .summon/team-default and honors an exact selected SUMMON_HOME', async () => {
		delete process.env.SUMMON_HOME;
		delete process.env.SUMMON_TEAMS_HOME;
		expect(storageRoot()).toBe(join(homedir(), '.summon', 'team-default'));
		const root = await useTemporaryStore();
		expect(storageRoot()).toBe(root);
	});

	test('stores the registered CLI, expertise, working directory, and sessions', async () => {
		await useTemporaryStore();
		const record = newRecord('Auden', '/work', 'codex');
		record.expertise = 'Knows the release process.';
		rememberSession(record, 'session-1');
		await saveAgent('auden', record);

		const loaded = await loadAgent('auden');
		expect(loaded).toEqual(record);
		if (!loaded) throw new Error('Expected the saved agent to load.');
		expect(loaded.provider).toBe('codex');
		expect(latestSession(loaded)?.id).toBe('session-1');
	});

	test('remembers and forgets sessions without changing the registered CLI', () => {
		const record = newRecord('Carl', '/work', 'claude');
		rememberSession(record, 'first');
		const firstCreatedAt = record.sessions[0]?.createdAt;
		rememberSession(record, 'second');
		rememberSession(record, 'first');
		expect(record.sessions.map((session) => session.id)).toEqual(['second', 'first']);
		expect(latestSession(record)?.createdAt).toBe(firstCreatedAt);
		forgetSession(record, 'first');
		expect(latestSession(record)?.id).toBe('second');
		expect(record.provider).toBe('claude');
	});

	test('rejects old, missing, or unknown provider records without guessing', async () => {
		const root = await useTemporaryStore();
		const valid = newRecord('Carl', '/work', 'claude');
		for (const record of [
			{ ...valid, provider: undefined },
			{ ...valid, provider: 'unknown' },
			{ ...valid, version: 1, sessions: { claude: [], codex: [] } },
			{ ...valid, sessions: { claude: [], codex: [] } },
			{ ...valid, sessions: [{ id: 'incomplete' }] },
			{
				...valid,
				sessions: [
					{
						id: '--dangerous-flag',
						createdAt: valid.createdAt,
						lastUsedAt: valid.createdAt,
					},
				],
			},
		]) {
			await writeFile(join(root, 'carl.json'), JSON.stringify(record));
			const result: unknown = await loadAgent('carl').catch((error: unknown) => error);
			expect(result).toBeInstanceOf(Error);
			if (!(result instanceof Error)) throw new Error('Expected an invalid-record error.');
			expect(result.message).toContain('Invalid agent record');
		}
	});

	test('keeps a domain across a save and reload, and accepts a record without one', async () => {
		const root = await useTemporaryStore();
		const record = newRecord('Jimmy', '/work', 'claude');
		record.domain = 'Frontend design across the web apps';
		await saveAgent('jimmy', record);
		expect((await loadAgent('jimmy'))?.domain).toBe('Frontend design across the web apps');

		// Every record written before the field existed lacks it and must still load.
		const older = { ...newRecord('Carl', '/work', 'claude') };
		delete (older as { domain?: string }).domain;
		await writeFile(join(root, 'carl.json'), JSON.stringify(older));
		expect((await loadAgent('carl'))?.domain).toBeUndefined();

		await writeFile(join(root, 'dave.json'), JSON.stringify({ ...older, domain: 7 }));
		expect(await loadAgent('dave').catch((error: unknown) => error)).toBeInstanceOf(Error);
	});

	test('rosters the other names that claim a domain', async () => {
		await useTemporaryStore();
		const jimmy = newRecord('Jimmy', '/work', 'claude');
		jimmy.domain = 'Frontend design';
		await saveAgent('jimmy', jimmy);
		const carl = newRecord('Carl', '/work', 'claude');
		carl.domain = 'Home network and storage';
		await saveAgent('carl', carl);
		// No domain: claims nothing, so no other session is told to hand work to it.
		await saveAgent('auden', newRecord('Auden', '/work', 'codex'));

		const roster = await listAgentDomains('jimmy');

		expect(roster).toEqual([
			{
				domain: 'Home network and storage',
				name: 'Carl',
				slug: 'carl',
				memberType: 'teammate',
			},
		]);
	});

	test('accepts safe names and rejects paths', () => {
		expect(slugFor('Carl')).toBe('carl');
		expect(() => slugFor('../carl')).toThrow();
		expect(() => slugFor('c'.repeat(65))).toThrow();
		for (const name of ['Agents', 'team-window', 'list', 'all'])
			expect(() => slugFor(name)).toThrow('reserved');
	});

	test('keeps notes in a markdown file beside the record', async () => {
		await useTemporaryStore();
		const record = newRecord('Carl', '/work', 'claude');
		record.expertise = 'Knows the release process.';
		await saveAgent('carl', record);

		await appendNote('carl', 'Shipped 0.2.0 on Tuesday.');
		await appendNote('carl', 'The release checklist moved.');

		expect(await readNotes('carl')).toBe(
			'Shipped 0.2.0 on Tuesday.\nThe release checklist moved.\n',
		);
		// The record itself stays the small stable thing beside them.
		expect((await loadAgent('carl'))?.expertise).toBe('Knows the release process.');
		expect(await readFile(notesPath('carl'), 'utf8')).toContain('Shipped 0.2.0 on Tuesday.');
	});

	test('refuses oversized history without appending or silently truncating startup notes', async () => {
		await useTemporaryStore();
		const original = `First recorded note\n${'x'.repeat(50_000)}`;
		await writeFile(notesPath('carl'), original);
		expect(appendNote('carl', 'Newest note')).rejects.toThrow('16 KiB');
		expect(await readFile(notesPath('carl'), 'utf8')).toBe(original);
		expect(readNotes('carl')).rejects.toThrow('16 KiB');
	});

	test('serializes concurrent note appends without losing either entry', async () => {
		await useTemporaryStore();
		await Promise.all([appendNote('carl', 'First'), appendNote('carl', 'Second')]);
		const lines = (await readFile(notesPath('carl'), 'utf8')).trim().split('\n').sort();
		expect(lines).toEqual(['First', 'Second']);
	});

	test('reads no notes for a name that has none', async () => {
		await useTemporaryStore();

		expect(await readNotes('nobody')).toBe('');
	});

	test('carries complete notes into a prompt within the byte limit', async () => {
		await useTemporaryStore();
		await appendNote('carl', `${'x'.repeat(16_000)}\nthe newest line`);

		const notes = await readNotes('carl');

		expect(notes).toContain('the newest line');
		expect(notes).toBe(`${'x'.repeat(16_000)}\nthe newest line\n`);
	});
});
