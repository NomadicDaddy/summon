import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SCRATCH_MAX_AGE_MS } from '../src/scratch-retention.ts';
import { cliHarness } from './fixtures/cli-harness.ts';
import { file, winTest } from './fixtures/scratch-store.ts';

winTest(
	'only the two operator starts purge, once and before launching; nothing else does',
	async () => {
		const fixture = await cliHarness();
		try {
			// Real time here: the CLI uses its own start time.
			const stale = new Date(Date.now() - SCRATCH_MAX_AGE_MS - 86_400_000);
			const sentinel = (root: string) => join(root, 'scratch', 'ada', 'old.txt');
			const named = join(fixture.teams, 'team-member');
			const plant = async () => {
				for (const root of [fixture.records, named]) await file(sentinel(root), stale);
			};
			const env = { SUMMON_AGENT: '' };
			await fixture.seed('claude');
			for (const args of [
				['member', '--same-window'],
				['__session', 'member'],
				['--mail', 'status'],
				['--status', 'idle', 'Ready'],
				['list'],
				['--no-such-option'],
			]) {
				await plant();
				await fixture.invoke(args, env);
				expect([args, existsSync(sentinel(fixture.records))]).toEqual([args, true]);
				expect([args, existsSync(sentinel(named))]).toEqual([args, true]);
			}
			for (const [args, selected, other] of [
				[['--team'], fixture.records, named],
				[['--team', 'member'], named, fixture.records],
				[['all'], fixture.records, named],
			] as const) {
				await plant();
				const result = await fixture.invoke([...args], env);
				expect([args, result.code]).toEqual([args, 0]);
				expect([args, existsSync(sentinel(selected))]).toEqual([args, false]);
				expect([args, existsSync(sentinel(other))]).toEqual([args, true]);
				const lines = result.stdout.split('\n');
				const expiry = lines.filter((line) => line.startsWith('Scratch expiry: removed 1'));
				expect([args, expiry.length]).toEqual([args, 1]);
				expect(result.launches.length).toBeGreaterThan(0);
				// Printed before anything the launch reports.
				expect(lines.findIndex((line) => line.startsWith('Scratch expiry'))).toBe(0);
			}
		} finally {
			await fixture.dispose();
		}
	},
	180_000,
);

test('source supplement: only summon-all.ts and team-window.ts call the operator purge', async () => {
	const callers: string[] = [];
	for (const name of await readdir('src', { recursive: true })) {
		if (!name.endsWith('.ts') || name.endsWith('scratch-retention.ts')) continue;
		if ((await readFile(join('src', name), 'utf8')).includes('operatorScratchExpiry('))
			callers.push(name.replaceAll('\\', '/'));
	}
	expect(callers.sort()).toEqual(['summon-all.ts', 'team-window.ts']);
});

test('the worker script and its C# source ship in the package', async () => {
	const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { files: string[] };
	expect(manifest.files).toContain('scripts/scratch-expiry.ps1');
	expect(manifest.files).toContain('scripts/scratch-expiry.cs');
});
