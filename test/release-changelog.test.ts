import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { rejects } from 'node:assert/strict';

import { checkReleaseVersion, checkWorkingReleaseVersion } from '../src/release-version.ts';
import { releaseFixture } from './fixtures/release-version-fixture.ts';

const fixtures: Awaited<ReturnType<typeof releaseFixture>>[] = [];
setDefaultTimeout(30_000);
async function fixture() {
	const value = await releaseFixture();
	fixtures.push(value);
	return value;
}
afterEach(async () => {
	for (const value of fixtures.splice(0)) await value.dispose();
});

test('moving history preserves old-root comparisons and clean historical rebuilds', async () => {
	const f = await fixture();
	f.git('mv', 'docs/CHANGELOG.md', 'CHANGELOG.md');
	const historical = f.commit('old root history');
	f.git('update-ref', 'refs/heads/main', historical, f.base);
	f.git('mv', 'CHANGELOG.md', 'docs/CHANGELOG.md');
	await f.write('src/app.ts', 'export const value=2;\n');
	await f.version('0.2.0');
	const migrated = f.commit('move history with a versioned source change');
	expect((await checkReleaseVersion(f.root, historical, migrated)).version).toBe('0.2.0');
	f.git('update-ref', 'refs/heads/main', migrated, historical);
	f.git('switch', '--detach', '--quiet', historical);
	expect((await checkWorkingReleaseVersion(f.root)).reason).toContain('historical main rebuild');
});

test('a new version cannot use root history as a missing canonical-file fallback', async () => {
	const f = await fixture();
	f.git('mv', 'docs/CHANGELOG.md', 'CHANGELOG.md');
	await f.write('CHANGELOG.md', f.notes('0.2.0'));
	await f.write('package.json', '{"version":"0.2.0"}\n');
	await rejects(checkReleaseVersion(f.root, f.base, f.commit()), /Missing candidate docs/u);
});

test('duplicate historical changelogs refuse instead of choosing a convenient baseline', async () => {
	const f = await fixture();
	await f.write('CHANGELOG.md', f.notes('0.1.0'));
	const ambiguous = f.commit();
	f.git('update-ref', 'refs/heads/main', ambiguous, f.base);
	await f.version('0.2.0');
	await rejects(checkReleaseVersion(f.root, ambiguous, f.commit()), /exactly one/u);
});

test('a new version refuses a second active root changelog', async () => {
	const f = await fixture();
	await f.version('0.2.0');
	await f.write('CHANGELOG.md', f.notes('0.1.0'));
	await rejects(checkReleaseVersion(f.root, f.base, f.commit()), /one public changelog/u);
});

test('same-version documentation changes still require the single canonical history', async () => {
	const f = await fixture();
	await f.write('CHANGELOG.md', f.notes('0.1.0'));
	await rejects(checkWorkingReleaseVersion(f.root), /one public changelog/u);
	f.git('rm', 'docs/CHANGELOG.md');
	await rejects(checkWorkingReleaseVersion(f.root), /Missing candidate docs/u);
});
