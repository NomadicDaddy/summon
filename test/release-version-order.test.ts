import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { copyFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { prepareTeamSeal } from '../scripts/prepare-team-seal.ts';
import {
	checkInstalledRelease,
	checkReleaseVersion,
	checkWorkingReleaseVersion,
} from '../src/release-version.ts';
import { releaseFixture } from './fixtures/release-version-fixture.ts';

const fixtures: Awaited<ReturnType<typeof releaseFixture>>[] = [];
setDefaultTimeout(30_000);
async function fixture() {
	const result = await releaseFixture({ summonStorageLayout: 1 });
	fixtures.push(result);
	return result;
}
afterEach(async () => {
	for (const item of fixtures.splice(0)) await item.dispose();
});

async function earlyBump(f: Awaited<ReturnType<typeof fixture>>) {
	await f.version('0.2.0');
	f.commit('version before the behavior change');
	await f.write('src/app.ts', 'export const value=2;\n');
	return f.commit('later behavior without another bump');
}

test('an earlier range bump cannot cover later runtime, even behind a test-only tip', async () => {
	const f = await fixture();
	const bad = await earlyBump(f);
	await rejects(checkReleaseVersion(f.root, f.base, bad), /without a version bump/u);
	await f.write('test/later.ts', 'export const testOnly = true;\n');
	await rejects(checkReleaseVersion(f.root, f.base, f.commit()), /without a version bump/u);
});

test('working runtime after an earlier bump refuses until the working version advances', async () => {
	const f = await fixture();
	await f.version('0.2.0');
	f.commit('early bump');
	await f.write('src/app.ts', 'export const value=2;\n');
	await rejects(checkWorkingReleaseVersion(f.root), /without a version bump/u);
	await f.version('0.3.0');
	expect((await checkWorkingReleaseVersion(f.root)).version).toBe('0.3.0');
});

test('installed-release comparison also refuses behavior newer than its version advance', async () => {
	const f = await fixture();
	const installed = JSON.stringify({ version: '0.1.0', revision: f.base });
	const bad = await earlyBump(f);
	await rejects(checkInstalledRelease(f.root, bad, installed), /without a version bump/u);
	await f.version('0.3.0');
	expect((await checkInstalledRelease(f.root, f.commit(), installed)).version).toBe('0.3.0');
});

test('build metadata after late runtime cannot replace a semantic version change', async () => {
	const f = await fixture();
	await earlyBump(f);
	await f.version('0.2.0+metadata');
	await rejects(checkWorkingReleaseVersion(f.root), /without a version bump/u);
	await rejects(checkReleaseVersion(f.root, f.base, f.commit()), /without a version bump/u);
});

test('a documented lower version covers earlier runtime while numeric ordering is removed', async () => {
	const f = await fixture();
	await earlyBump(f);
	await f.version('0.1.9');
	expect((await checkReleaseVersion(f.root, f.base, f.commit())).version).toBe('0.1.9');
});

test('the real main-ref hook preserves main for an early bump and accepts a final bump', async () => {
	const f = await fixture();
	const bad = await earlyBump(f);
	await f.version('0.3.0');
	const good = f.commit('final version covers the accumulated behavior');
	f.git('config', 'core.hooksPath', resolve(import.meta.dir, '../.githooks'));
	const refused = f.run('update-ref', 'refs/heads/main', bad, f.base);
	expect(refused.exitCode).not.toBe(0);
	expect(refused.stderr.toString()).toContain('without a version bump');
	expect(f.git('rev-parse', 'refs/heads/main')).toBe(f.base);
	expect(f.run('update-ref', 'refs/heads/main', good, f.base).exitCode).toBe(0);
	expect(f.git('rev-parse', 'refs/heads/main')).toBe(good);
});

test('the actual build refuses the range-order defect before removing old output', async () => {
	const f = await fixture();
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
	await earlyBump(f);
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
	await f.version('0.3.0');
	const accepted = run();
	// No desktop entry exists in this fixture. Reaching the builder is the positive guard control.
	expect(accepted.exitCode).not.toBe(0);
	expect(accepted.stderr.toString()).not.toContain('without a version bump');
	expect(await Bun.file(join(f.root, 'dist/team/preserved.txt')).exists()).toBe(false);
});

test('seal refusal preserves the existing seal and bundle for an early range bump', async () => {
	const f = await fixture();
	const bad = await earlyBump(f);
	await f.write(
		'dist/team/build.json',
		JSON.stringify({ version: '0.2.0', revision: bad, buildId: 'fixture' }),
	);
	await f.write('dist/team/main.mjs', 'keep candidate bundle\n');
	const installedText = JSON.stringify({ version: '0.1.0', revision: f.base });
	await f.write('installed/build.json', installedText);
	await f.write('seal.json', 'keep existing seal\n');
	await rejects(
		prepareTeamSeal(f.root, join(f.root, 'installed'), join(f.root, 'seal.json')),
		/without a version bump/u,
	);
	expect(await readFile(join(f.root, 'seal.json'), 'utf8')).toBe('keep existing seal\n');
	expect(await readFile(join(f.root, 'dist/team/main.mjs'), 'utf8')).toBe(
		'keep candidate bundle\n',
	);
	expect(await readFile(join(f.root, 'installed/build.json'), 'utf8')).toBe(installedText);
});

test('a later notes repair qualifies the final candidate and its subsequent main preflight', async () => {
	const f = await fixture();
	await f.write('src/app.ts', 'export const value=2;\n');
	await f.version('0.2.0');
	await f.write('docs/CHANGELOG.md', '## [0.2.0] - 2026-10-20\n\nUncategorized notes.\n');
	const bad = f.commit('behavior and version, but malformed notes');
	await rejects(checkReleaseVersion(f.root, f.base, bad), /categorized release notes/u);
	await f.write('docs/CHANGELOG.md', f.notes('0.2.0'));
	const repaired = f.commit('repair only the release notes');
	expect((await checkReleaseVersion(f.root, f.base, repaired)).version).toBe('0.2.0');
	expect((await checkWorkingReleaseVersion(f.root)).version).toBe('0.2.0');
	f.git('update-ref', 'refs/heads/main', repaired, f.base);
	expect((await checkWorkingReleaseVersion(f.root)).reason).toBe('test/documentation-only');
});

for (const order of ['with runtime', 'after runtime']) {
	test(`a version advance ${order} still allows later test, docs and formatter changes`, async () => {
		const f = await fixture();
		await f.write('src/app.ts', 'export const value=2;\n');
		if (order === 'after runtime') f.commit('unversioned behavior');
		await f.version('0.2.0');
		f.commit('cover the new behavior');
		await f.write('test/later.ts', 'export const testOnly = true;\n');
		await f.write('README.md', 'Later documentation.\n');
		await f.write('src/app.ts', 'export const value = 2;\n');
		const tip = f.commit('only test, docs and formatting after the advance');
		expect((await checkReleaseVersion(f.root, f.base, tip)).version).toBe('0.2.0');
		expect((await checkWorkingReleaseVersion(f.root)).version).toBe('0.2.0');
	});
}
