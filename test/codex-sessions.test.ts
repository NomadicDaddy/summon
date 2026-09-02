import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findNewCodexSession } from '../src/codex-sessions.ts';

let temporaryRoot: string | undefined;

afterEach(async () => {
	if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
	temporaryRoot = undefined;
	delete process.env.CODEX_HOME;
});

test('discovers a new Codex session for the stored working directory', async () => {
	temporaryRoot = await mkdtemp(join(tmpdir(), 'summon-codex-test-'));
	process.env.CODEX_HOME = temporaryRoot;
	const directory = join(temporaryRoot, 'sessions', '2026', '09', '01');
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, 'session.jsonl'),
		`${JSON.stringify({
			type: 'session_meta',
			payload: { id: 'session-1', cwd: process.cwd() },
		})}\n`,
	);

	expect(await findNewCodexSession(process.cwd(), Date.now())).toBe('session-1');
});
