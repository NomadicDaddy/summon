import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newRecord, saveAgent } from '../../src/store.ts';

export async function diaryRejection(work: Promise<unknown>): Promise<Error> {
	try {
		await work;
	} catch (error: unknown) {
		if (error instanceof Error) return error;
		throw error;
	}
	throw new Error('Expected the Diary operation to reject.');
}

/** Runs only in the project's isolated test child, never in a provider's real launch. */
export async function withDiaryFixture(work: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'summon-diary-batch-'));
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = root;
	try {
		await saveAgent('writer', newRecord('Writer', root, 'codex'));
		await saveAgent('constructor', newRecord('Constructor', root, 'claude'));
		await work(root);
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await rm(root, { recursive: true, force: true });
	}
}
