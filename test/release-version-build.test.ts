import { afterEach, expect, test } from 'bun:test';
import { copyFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { releaseFixture } from './fixtures/release-version-fixture.ts';

const fixtures: Awaited<ReturnType<typeof releaseFixture>>[] = [];
afterEach(async () => {
	for (const item of fixtures.splice(0)) await item.dispose();
});

// Two build children each allow 20 seconds, in addition to the real Git fixture setup.
test('the actual build consumer refuses before removing old output, with an accepting control', async () => {
	const f = await releaseFixture({ summonStorageLayout: 1 });
	fixtures.push(f);
	await f.write('src/app.ts', 'export const value=2;\n');
	f.commit();
	for (const name of [
		'team-build.ts',
		'team-build-options.ts',
		'release-changelog.ts',
		'release-version.ts',
		'release-version-git.ts',
		'executable.ts',
	])
		await copyFile(resolve(import.meta.dir, '../src', name), join(f.root, 'src', name));
	await f.write(
		'scripts/build-team.ts',
		"import { buildTeam } from '../src/team-build.ts';\nawait buildTeam();\n",
	);
	await f.write('dist/team/preserved.txt', 'old bundle stays\n');
	const run = () =>
		Bun.spawnSync([process.execPath, join(f.root, 'scripts/build-team.ts')], {
			cwd: f.root,
			windowsHide: true,
			timeout: 20_000,
		});
	const refused = run();
	expect(refused.exitCode).not.toBe(0);
	expect(refused.stderr.toString()).toContain('without a version bump');
	expect(await readFile(join(f.root, 'dist/team/preserved.txt'), 'utf8')).toBe(
		'old bundle stays\n',
	);
	await f.version('0.2.0');
	const accepted = run();
	// This fixture intentionally has no desktop entry points. Reaching the builder proves the
	// guard accepted; it is not a successful app build or native-window result.
	expect(accepted.exitCode).not.toBe(0);
	expect(accepted.stderr.toString()).not.toContain('without a version bump');
	expect(await Bun.file(join(f.root, 'dist/team/preserved.txt')).exists()).toBe(false);
}, 60_000);
