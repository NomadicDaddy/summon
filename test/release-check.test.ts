import { afterEach, expect, test } from 'bun:test';
import { copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { releaseFixture } from './fixtures/release-version-fixture.ts';

const fixtures: Awaited<ReturnType<typeof releaseFixture>>[] = [];
afterEach(async () => {
	for (const item of fixtures.splice(0)) await item.dispose();
});

test('release:check refuses when main advances during its quality gate', async () => {
	const f = await releaseFixture();
	fixtures.push(f);
	for (const name of [
		'release-candidate.ts',
		'release-changelog.ts',
		'release-version.ts',
		'release-version-git.ts',
		'executable.ts',
	])
		await copyFile(resolve(import.meta.dir, '../src', name), join(f.root, 'src', name));
	await f.write(
		'scripts/release-check.ts',
		await Bun.file(resolve(import.meta.dir, '../scripts/release-check.ts')).text(),
	);
	await f.version('0.2.0');
	await f.write('src/app.ts', 'export const value=2;\n');
	await f.write(
		'package.json',
		`${JSON.stringify({ name: 'fixture', version: '0.2.0', scripts: { 'smoke:qc': 'bun scripts/move-main.ts' } })}\n`,
	);
	await f.write(
		'scripts/move-main.ts',
		"const ref = Bun.spawnSync(['git', 'rev-parse', 'later'], { cwd: process.cwd() });\nif (ref.exitCode !== 0) throw new Error(ref.stderr.toString());\nconst move = Bun.spawnSync(['git', 'update-ref', 'refs/heads/main', ref.stdout.toString().trim()], { cwd: process.cwd() });\nif (move.exitCode !== 0) throw new Error(move.stderr.toString());\n",
	);
	const candidate = f.commit('clean versioned candidate');
	f.git('switch', '--quiet', '-c', 'later');
	await f.write('docs/later.md', 'Later main commit.\n');
	const later = f.commit('advance main during QC');
	f.git('switch', '--quiet', 'candidate');
	const result = Bun.spawnSync([process.execPath, join(f.root, 'scripts/release-check.ts')], {
		cwd: f.root,
		windowsHide: true,
		timeout: 20_000,
	});
	expect(result.exitCode).not.toBe(0);
	expect(result.stderr.toString()).toContain('Release baseline main changed during checks.');
	expect(f.git('rev-parse', 'HEAD')).toBe(candidate);
	expect(f.git('rev-parse', 'refs/heads/main')).toBe(later);
}, 30_000);
