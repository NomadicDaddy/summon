import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
	appendNote,
	forgetSession,
	latestSession,
	loadAgent,
	newRecord,
	rememberSession,
	saveAgent,
	slugFor,
} from '../src/store.ts';

let temporaryRoot: string | undefined;
const previousRoot = process.env.SUMMON_HOME;

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
});

async function useTemporaryStore(): Promise<string> {
	temporaryRoot = await mkdtemp(join(tmpdir(), 'summon-test-'));
	process.env.SUMMON_HOME = temporaryRoot;
	return temporaryRoot;
}

describe('agent storage', () => {
	test('stores the registered CLI, notes, working directory, and sessions', async () => {
		await useTemporaryStore();
		const record = newRecord('Auden', '/work', 'codex');
		record.notes = 'Knows the release process.';
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
		]) {
			await writeFile(join(root, 'carl.json'), JSON.stringify(record));
			const result: unknown = await loadAgent('carl').catch((error: unknown) => error);
			expect(result).toBeInstanceOf(Error);
			if (!(result instanceof Error)) throw new Error('Expected an invalid-record error.');
			expect(result.message).toContain('Invalid agent record');
		}
	});

	test('accepts safe names and rejects paths', () => {
		expect(slugFor('Carl')).toBe('carl');
		expect(() => slugFor('../carl')).toThrow();
		expect(() => slugFor('c'.repeat(65))).toThrow();
	});

	test('limits notes to a safe command-line size', () => {
		const record = newRecord('Carl', '/work', 'claude');
		appendNote(record, 'Useful note');
		expect(record.notes).toBe('Useful note');
		expect(() => appendNote(record, 'x'.repeat(16_000))).toThrow();
	});
});
