import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadAgent, newRecord, recordPath, rememberSession, saveAgent } from '../src/store.ts';

let temporaryRoot: string | undefined;

afterEach(async () => {
	if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
	temporaryRoot = undefined;
});

test('invalid session IDs cannot replace a valid stored record', async () => {
	temporaryRoot = await mkdtemp(join(tmpdir(), 'summon-codex-test-'));
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = temporaryRoot;
	try {
		const record = newRecord('Guarded', temporaryRoot, 'codex');
		await saveAgent('guarded', record);
		const before = await readFile(recordPath('guarded'), 'utf8');
		rememberSession(record, '--unsafe');
		let failure: unknown;
		await saveAgent('guarded', record).catch((error: unknown) => {
			failure = error;
		});
		expect(failure).toBeDefined();
		expect(await readFile(recordPath('guarded'), 'utf8')).toBe(before);
		expect((await loadAgent('guarded'))?.sessions).toEqual([]);
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
	}
});
