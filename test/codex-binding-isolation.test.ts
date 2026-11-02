import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cliHarness } from './fixtures/cli-harness.ts';

let fixture: Awaited<ReturnType<typeof cliHarness>>;
beforeEach(async () => {
	fixture = await cliHarness();
});
afterEach(async () => {
	await fixture.dispose();
});

async function foreignHistory(): Promise<void> {
	const path = join(fixture.root, 'codex', 'sessions');
	await mkdir(path, { recursive: true });
	await writeFile(
		join(path, 'foreign-team.jsonl'),
		JSON.stringify({
			type: 'session_meta',
			timestamp: new Date().toISOString(),
			payload: { id: 'foreign-team-thread', cwd: fixture.project },
		}),
	);
}

test('unbound fresh launch never adopts another team thread from a shared working folder', async () => {
	await foreignHistory();
	const result = await fixture.invoke(['member', '--using', 'codex', '--same-window'], {
		SUMMON_TEST_CODEX_NO_BINDING: '1',
		SUMMON_TEST_CODEX_NO_HISTORY: '1',
	});
	expect(result.code).toBe(0);
	expect((await fixture.saved()).sessions).toEqual([]);
	expect(result.stderr).toContain('exact launch binding');
	const next = await fixture.invoke(['member', '--same-window'], {
		SUMMON_TEST_CODEX_NO_BINDING: '1',
		SUMMON_TEST_CODEX_NO_HISTORY: '1',
	});
	expect(next.launches[0]?.cmd).not.toContain('resume');
	expect(next.launches[0]?.cmd).not.toContain('foreign-team-thread');
	expect((await fixture.saved()).sessions).toEqual([]);
});

test('explicit launch binding wins over foreign same-folder history and resumes exactly', async () => {
	await foreignHistory();
	const result = await fixture.invoke(['member', '--using', 'codex', '--same-window'], {
		SUMMON_TEST_CODEX_BINDING: 'exact-owned-thread',
		SUMMON_TEST_CODEX_NO_HISTORY: '1',
	});
	expect(result.code).toBe(0);
	expect((await fixture.saved()).sessions.map(({ id }) => id)).toEqual(['exact-owned-thread']);
	const next = await fixture.invoke(['member', '--same-window']);
	expect(next.launches[0]?.cmd.slice(0, 2)).toEqual(['codex', 'resume']);
	expect(next.launches[0]?.cmd).toContain('exact-owned-thread');
	expect(next.launches[0]?.cmd).not.toContain('foreign-team-thread');
});

test('malformed exact binding never falls back to foreign history', async () => {
	await foreignHistory();
	const result = await fixture.invoke(['member', '--using', 'codex', '--same-window'], {
		SUMMON_TEST_CODEX_BINDING: '--unsafe',
		SUMMON_TEST_CODEX_NO_HISTORY: '1',
	});
	expect(result.code).toBe(0);
	expect((await fixture.saved()).sessions).toEqual([]);
	expect(result.stderr).toContain('plain provider identifier');
});
