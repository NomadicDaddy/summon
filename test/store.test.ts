import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	appendNote,
	latestSession,
	loadAgent,
	newRecord,
	rememberSession,
	saveAgent,
	slugFor,
} from '../src/store.ts';

let temporaryRoot: string | undefined;

afterEach(async () => {
	if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
	temporaryRoot = undefined;
	delete process.env.SUMMON_HOME;
});

describe('agent storage', () => {
	test('stores name, notes, working directory, and provider sessions', async () => {
		temporaryRoot = await mkdtemp(join(tmpdir(), 'summon-test-'));
		process.env.SUMMON_HOME = temporaryRoot;
		const record = newRecord('Carl', '/work');
		record.notes = 'Knows the release process.';
		rememberSession(record, 'codex', 'session-1');
		await saveAgent('carl', record);

		const loaded = await loadAgent('carl');
		if (!loaded) throw new Error('Expected the saved agent to load.');
		expect(loaded.name).toBe('Carl');
		expect(loaded.notes).toBe('Knows the release process.');
		expect(latestSession(loaded, 'codex')?.id).toBe('session-1');
	});

	test('accepts safe names and rejects paths', () => {
		expect(slugFor('Carl')).toBe('carl');
		expect(() => slugFor('../carl')).toThrow();
		expect(() => slugFor('c'.repeat(65))).toThrow();
	});

	test('limits notes to a safe command-line size', () => {
		const record = newRecord('Carl', '/work');
		appendNote(record, 'Useful note');
		expect(record.notes).toBe('Useful note');
		expect(() => appendNote(record, 'x'.repeat(16_000))).toThrow();
	});
});
