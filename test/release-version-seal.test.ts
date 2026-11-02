import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { prepareTeamSeal } from '../scripts/prepare-team-seal.ts';
import { releaseFixture } from './fixtures/release-version-fixture.ts';

const fixtures: Awaited<ReturnType<typeof releaseFixture>>[] = [];
// Seal controls inspect real Git histories more than once and retain all refusal assertions.
setDefaultTimeout(30_000);
async function fixture(bump = true) {
	const f = await releaseFixture();
	fixtures.push(f);
	await f.write('src/app.ts', 'export const value=2;\n');
	if (bump) await f.version('0.2.0');
	const candidate = f.commit();
	await f.write(
		'dist/team/build.json',
		JSON.stringify({
			version: bump ? '0.2.0' : '0.1.0',
			revision: candidate,
			buildId: 'fixture',
		}),
	);
	await f.write('dist/team/main.mjs', 'export const fixture = true;\n');
	await f.write(
		'installed/build.json',
		JSON.stringify({ version: '0.1.0', revision: f.base, buildId: 'old-fixture' }),
	);
	return {
		...f,
		candidate,
		installed: join(f.root, 'installed'),
		output: join(f.root, 'seal.json'),
	};
}
afterEach(async () => {
	for (const item of fixtures.splice(0)) await item.dispose();
});

test('a clean versioned candidate produces an inventory without copying or adopting a bundle', async () => {
	const f = await fixture();
	const before = await readFile(join(f.installed, 'build.json'), 'utf8');
	const result = await prepareTeamSeal(f.root, f.installed, f.output);
	expect(result).toMatchObject({
		sealed: true,
		version: '0.2.0',
		files: 2,
		adopted: false,
		restarted: false,
	});
	const seal: unknown = JSON.parse(await readFile(f.output, 'utf8'));
	expect(seal).toMatchObject({
		candidate: f.candidate,
		independentBuildVerified: false,
		adoptionAuthorized: false,
	});
	expect(seal).toHaveProperty('files.1.path', 'main.mjs');
	expect(seal).toHaveProperty('files.1.bytes', 29);
	expect(await readFile(join(f.installed, 'build.json'), 'utf8')).toBe(before);
});

test('the candidate cannot be its own installed bundle, including a Windows case alias', async () => {
	const f = await fixture();
	const built = join(f.root, 'dist/team');
	const before = await readFile(join(built, 'build.json'), 'utf8');
	await rejects(prepareTeamSeal(f.root, built, f.output), /distinct physical directories/u);
	if (process.platform === 'win32')
		await rejects(
			prepareTeamSeal(f.root, built.toUpperCase(), f.output),
			/distinct physical directories/u,
		);
	expect(await Bun.file(f.output).exists()).toBe(false);
	expect(await readFile(join(built, 'build.json'), 'utf8')).toBe(before);
});

test('a same-version runtime change refuses before an existing seal or bundle is changed', async () => {
	const f = await fixture(false);
	await f.write('seal.json', 'preserved seal\n');
	const before = await readFile(join(f.root, 'dist/team/main.mjs'), 'utf8');
	await rejects(prepareTeamSeal(f.root, f.installed, f.output), /without a version bump/u);
	expect(await readFile(f.output, 'utf8')).toBe('preserved seal\n');
	expect(await readFile(join(f.root, 'dist/team/main.mjs'), 'utf8')).toBe(before);
});

test('a valid seal never overwrites an existing output', async () => {
	const f = await fixture();
	await f.write('seal.json', 'keep this\n');
	await rejects(prepareTeamSeal(f.root, f.installed, f.output));
	expect(await readFile(f.output, 'utf8')).toBe('keep this\n');
});

test('a seal cannot add files inside either the candidate or installed bundle', async () => {
	const f = await fixture();
	for (const output of [join(f.root, 'dist/team/seal.json'), join(f.installed, 'seal.json')]) {
		await rejects(prepareTeamSeal(f.root, f.installed, output), /outside both bundles/u);
		expect(await Bun.file(output).exists()).toBe(false);
	}
});

test('an output-parent junction cannot alias the candidate bundle', async () => {
	const f = await fixture();
	const alias = join(f.root, 'dist/output-alias');
	await symlink(
		join(f.root, 'dist/team'),
		alias,
		process.platform === 'win32' ? 'junction' : 'dir',
	);
	await rejects(
		prepareTeamSeal(f.root, f.installed, join(alias, 'seal.json')),
		/outside both bundles/u,
	);
	expect(await Bun.file(join(f.root, 'dist/team/seal.json')).exists()).toBe(false);
});

test('dirty source, mismatched built identity and unknown installed revisions refuse', async () => {
	const f = await fixture();
	await f.write('src/app.ts', 'export const value=3;\n');
	await rejects(prepareTeamSeal(f.root, f.installed, f.output), /clean source/u);
	f.git('restore', '--', 'src/app.ts');
	await f.write('dist/team/build.json', JSON.stringify({ version: '0.2.0', revision: f.base }));
	await rejects(prepareTeamSeal(f.root, f.installed, f.output), /Built identity/u);
	await f.write(
		'installed/build.json',
		JSON.stringify({ version: '0.1.0', revision: '0000000' }),
	);
	await rejects(prepareTeamSeal(f.root, f.installed, f.output));
	expect(await Bun.file(f.output).exists()).toBe(false);
});

test('bundle directory links are refused without traversal', async () => {
	const f = await fixture();
	await symlink(
		f.installed,
		join(f.root, 'dist/team/linked'),
		process.platform === 'win32' ? 'junction' : 'dir',
	);
	await rejects(prepareTeamSeal(f.root, f.installed, f.output), /links/u);
	expect(await Bun.file(f.output).exists()).toBe(false);
});
