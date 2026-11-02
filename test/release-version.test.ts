import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { releaseGit } from '../src/release-version-git.ts';
import {
	checkInstalledRelease,
	checkReleaseVersion,
	checkWorkingReleaseVersion,
	sourceVersion,
} from '../src/release-version.ts';
import { releaseFixture } from './fixtures/release-version-fixture.ts';

const fixtures: Awaited<ReturnType<typeof releaseFixture>>[] = [];
// Each case starts several real native Git processes; five seconds is not a useful bound.
setDefaultTimeout(30_000);
async function fixture() {
	const result = await releaseFixture();
	fixtures.push(result);
	return result;
}
afterEach(async () => {
	for (const item of fixtures.splice(0)) await item.dispose();
});

test('a runtime change requires a changed version and categorized dated notes', async () => {
	const f = await fixture();
	await f.write('src/app.ts', 'export const value=2;\n');
	const unversioned = f.commit();
	await rejects(checkReleaseVersion(f.root, f.base, unversioned), /without a version bump/u);
	await f.version('0.2.0');
	const candidate = f.commit();
	const result = await checkReleaseVersion(f.root, f.base, candidate);
	expect(result).toMatchObject({ version: '0.2.0', previousVersion: '0.1.0', baseline: f.base });
});

test('a test-only tip cannot conceal an earlier unversioned runtime change on main', async () => {
	const f = await fixture();
	await f.write('src/app.ts', 'export const value=2;\n');
	const badMain = f.commit();
	f.git('update-ref', 'refs/heads/main', badMain, f.base);
	await f.write('test/note.ts', 'export const fixture = true;\n');
	const candidate = f.commit();
	await rejects(checkReleaseVersion(f.root, badMain, candidate), /without a version bump/u);
});

test('test-only and documentation-only commits report the exemption', async () => {
	const f = await fixture();
	await f.write('test/new.test.ts', 'export const testOnly = true;\n');
	await f.write('README.md', 'Fixture documentation.\n');
	const result = await checkReleaseVersion(f.root, f.base, f.commit());
	expect(result.reason).toBe('test/documentation-only');
	expect(result.version).toBe('0.1.0');
});

test('public site and root policy prose retain the application version', async () => {
	const f = await fixture();
	await f.write('site/index.html', '<h1>Public documentation</h1>\n');
	for (const path of ['SECURITY.md', 'PRIVACY.md', 'SUPPORT.md'])
		await f.write(path, 'Current project policy.\n');
	expect((await checkWorkingReleaseVersion(f.root)).reason).toBe('test/documentation-only');
	expect((await checkReleaseVersion(f.root, f.base, f.commit())).version).toBe('0.1.0');
});

test('the installed formatter proves formatting-only changes without ignoring string contents', async () => {
	const f = await fixture();
	await f.write('src/app.ts', 'export const value = 1;\n');
	const formatted = f.commit();
	expect((await checkReleaseVersion(f.root, f.base, formatted)).reason).toContain(
		'formatter-equivalent',
	);
	await f.write('src/app.ts', "export const value = 'a  b';\n");
	await rejects(checkReleaseVersion(f.root, f.base, f.commit()), /without a version bump/u);
});

test('bundled instructions and guard scripts are shipped changes', async () => {
	const f = await fixture();
	await f.write('skills/summon-receive/SKILL.md', 'A changed startup rule.\n');
	await rejects(checkReleaseVersion(f.root, f.base, f.commit()), /without a version bump/u);
});

test('lossy binary decoding cannot establish a formatting exemption', async () => {
	const f = await fixture();
	await writeFile(join(f.root, 'src/app.ts'), new Uint8Array([0xff]));
	const base = f.commit();
	f.git('update-ref', 'refs/heads/main', base, f.base);
	await writeFile(join(f.root, 'src/app.ts'), new Uint8Array([0xfe]));
	await rejects(checkWorkingReleaseVersion(f.root), /Non-UTF-8/u);
	await rejects(checkReleaseVersion(f.root, base, f.commit()), /Non-UTF-8/u);
	await f.version('0.2.0');
	expect((await checkReleaseVersion(f.root, base, f.commit())).version).toBe('0.2.0');
});

test('an executable-mode change is behavior even when file contents are identical', async () => {
	const f = await fixture();
	f.git('update-index', '--chmod=+x', 'src/app.ts');
	await rejects(checkWorkingReleaseVersion(f.root), /without a version bump/u);
	f.git('commit', '--quiet', '-m', 'make fixture executable');
	await rejects(
		checkReleaseVersion(f.root, f.base, f.git('rev-parse', 'HEAD')),
		/without a version bump/u,
	);
});

test('working source and untracked shipped files are checked before a commit', async () => {
	const f = await fixture();
	await f.write('src/new.ts', 'export const added = true;\n');
	await rejects(checkWorkingReleaseVersion(f.root), /without a version bump/u);
	await f.version('0.2.0');
	expect((await checkWorkingReleaseVersion(f.root)).version).toBe('0.2.0');
});

test('CRLF normalization warnings do not hide the actual working source classification', async () => {
	const f = await fixture();
	await f.write('.gitattributes', '* text eol=lf\n');
	await f.version('0.2.0');
	const baseline = f.commit();
	f.git('update-ref', 'refs/heads/main', baseline, f.base);
	f.git('config', 'core.autocrlf', 'true');
	f.git('config', 'core.safecrlf', 'warn');
	await f.write('src/app.ts', 'export const value=3;\r\n');
	const control = f.run('diff', '--name-only', 'HEAD', '--', 'src/app.ts');
	expect(control.exitCode).toBe(0);
	expect(control.stderr.toString()).toContain('CRLF');
	await rejects(checkWorkingReleaseVersion(f.root), /without a version bump/u);
	await f.version('0.3.0');
	expect((await checkWorkingReleaseVersion(f.root)).version).toBe('0.3.0');
	expect(f.git('config', 'core.safecrlf')).toBe('warn');
});

test('other zero-exit Git warnings still refuse inspection', async () => {
	const f = await fixture();
	f.git('tag', 'main');
	f.git('config', 'core.warnAmbiguousRefs', 'true');
	const control = f.run('rev-parse', 'main');
	expect(control.exitCode).toBe(0);
	expect(control.stderr.toString()).toContain('ambiguous');
	expect(() => releaseGit(f.root, ['rev-parse', 'main'])).toThrow('ambiguous');
});

test('a version bump needs its own real dated notes', async () => {
	const f = await fixture();
	await f.write('package.json', '{"version":"0.2.0"}\n');
	await rejects(checkReleaseVersion(f.root, f.base, f.commit()), /Missing dated/u);
	await f.write('docs/CHANGELOG.md', '## [0.2.0] - 2026-02-31\n\n### Fixed\n\n- A change.\n');
	await rejects(checkReleaseVersion(f.root, f.base, f.commit()), /Invalid changelog date/u);
});

test('Removed and Deprecated are supported release-note categories', async () => {
	const f = await fixture();
	await f.version('0.2.0');
	for (const category of ['Removed', 'Deprecated']) {
		await f.write(
			'docs/CHANGELOG.md',
			f.notes('0.2.0').replace('### Fixed', `### ${category}`),
		);
		expect((await checkReleaseVersion(f.root, f.base, f.commit())).version).toBe('0.2.0');
	}
});

test('a release note belongs inside a recognized category', async () => {
	const f = await fixture();
	await f.version('0.2.0');
	for (const body of [
		'- An uncategorized note.\n\n### Fixed\n',
		'### Added\n\n### Internal\n\n- A note under an unrecognized heading.\n',
	]) {
		await f.write('docs/CHANGELOG.md', `## [0.2.0] - 2026-10-20\n\n${body}`);
		await rejects(
			checkReleaseVersion(f.root, f.base, f.commit()),
			/categorized release notes/u,
		);
	}
	await f.write('docs/CHANGELOG.md', f.notes('0.2.0'));
	expect((await checkReleaseVersion(f.root, f.base, f.commit())).version).toBe('0.2.0');
});

test('unchanged prewritten future notes do not qualify a later integration', async () => {
	const f = await fixture();
	await f.write('docs/CHANGELOG.md', `${f.notes('0.2.0')}\n${f.notes('0.1.0')}`);
	const planned = f.commit();
	f.git('update-ref', 'refs/heads/main', planned, f.base);
	await f.write('package.json', '{"version":"0.2.0"}\n');
	await f.write('src/app.ts', 'export const value=2;\n');
	await rejects(checkReleaseVersion(f.root, planned, f.commit()), /not updated/u);
});

test('missing history, non-ancestor pins and invalid identities refuse', async () => {
	const f = await fixture();
	await rejects(checkReleaseVersion(f.root, '0000000', f.base));
	await rejects(checkReleaseVersion(f.root, '--help', f.base), /exact commit/u);
	await f.write('src/app.ts', 'export const value=2;\n');
	const later = f.commit();
	await rejects(checkReleaseVersion(f.root, later, f.base));
});

test('a shallow checkout refuses instead of inventing its release baseline', async () => {
	const f = await fixture();
	const clone = join(f.root, 'shallow-copy');
	const result = f.run(
		'clone',
		'--quiet',
		'--depth=1',
		'--branch=main',
		pathToFileURL(f.root).href,
		clone,
	);
	expect(result.exitCode).toBe(0);
	await rejects(checkWorkingReleaseVersion(clone), /Complete source history/u);
});

test('the pull-request checkout establishes main before checking a detached candidate', async () => {
	const f = await fixture();
	await f.write('README.md', 'A documentation-only pull request.\n');
	const candidate = f.commit();
	f.git('update-ref', 'refs/remotes/origin/main', f.base);
	f.git('switch', '--detach', '--quiet', candidate);
	f.git('branch', '-d', 'main');
	await rejects(checkWorkingReleaseVersion(f.root));
	f.git('branch', 'main', 'origin/main');
	expect((await checkWorkingReleaseVersion(f.root)).reason).toBe('test/documentation-only');
});

test('a documented lower version establishes the working and installed baseline', async () => {
	const f = await fixture();
	await f.version('1.0.2');
	const internal = f.commit();
	f.git('update-ref', 'refs/heads/main', internal, f.base);
	await f.version('1.0.0');
	expect((await checkWorkingReleaseVersion(f.root)).version).toBe('1.0.0');
	const normalized = f.commit();
	expect((await checkReleaseVersion(f.root, internal, normalized)).version).toBe('1.0.0');
	f.git('config', 'core.hooksPath', resolve(import.meta.dir, '../.githooks'));
	f.git('update-ref', 'refs/heads/main', normalized, internal);
	expect((await checkWorkingReleaseVersion(f.root)).baseline).toBe(normalized);
	const installed = JSON.stringify({ version: '1.0.2', revision: internal });
	expect((await checkInstalledRelease(f.root, normalized, installed)).version).toBe('1.0.0');
	await f.write('README.md', 'Public release documentation.\n');
	expect((await checkWorkingReleaseVersion(f.root)).reason).toBe('test/documentation-only');
	await f.write('src/app.ts', 'export const value=2;\n');
	await rejects(checkWorkingReleaseVersion(f.root), /without a version bump/u);
});

test('installed same-version runtime changes refuse, while a test-only revision can qualify', async () => {
	const f = await fixture();
	const installed = JSON.stringify({ version: '0.1.0', revision: f.base });
	await f.write('test/test.ts', 'export const fixtureOnly=true;\n');
	const safe = f.commit();
	expect((await checkInstalledRelease(f.root, safe, installed)).reason).toBe(
		'test/documentation-only',
	);
	await f.write('src/app.ts', 'export const value=2;\n');
	await rejects(checkInstalledRelease(f.root, f.commit(), installed), /without a version bump/u);
	await rejects(
		checkInstalledRelease(f.root, safe, JSON.stringify({ version: '9.0.0', revision: f.base })),
		/disagrees/u,
	);
});

test('semantic versions preserve prerelease ordering and reject malformed components', () => {
	expect(sourceVersion('{"version":"0.2.0-rc.1+build.2"}')).toBe('0.2.0-rc.1+build.2');
	for (const version of ['1.00.0', '1.0.0-01', '1.0.0-', '1.0', 'next'])
		expect(() => sourceVersion(JSON.stringify({ version }))).toThrow('semantic');
});
