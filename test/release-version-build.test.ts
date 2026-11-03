import { afterEach, expect, test } from 'bun:test';
import { copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { releaseFixture } from './fixtures/release-version-fixture.ts';

const fixtures: Awaited<ReturnType<typeof releaseFixture>>[] = [];
afterEach(async () => {
	for (const item of fixtures.splice(0)) await item.dispose();
});

test('a development Team Window build reaches the builder without a version bump', async () => {
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
	const result = run();
	// This fixture has no desktop sources. The missing-directory error shows the build began;
	// this does not prove successful artifact production or native-window acceptance.
	expect(result.exitCode).not.toBe(0);
	expect(result.stderr.toString()).toContain('ENOENT');
	expect(result.stderr.toString()).not.toContain('without a version bump');
	expect(await Bun.file(join(f.root, 'dist/team/preserved.txt')).exists()).toBe(false);
}, 30_000);
