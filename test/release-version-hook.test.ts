import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { join, resolve } from 'node:path';

import { releaseFixture } from './fixtures/release-version-fixture.ts';

const fixtures: Awaited<ReturnType<typeof releaseFixture>>[] = [];
setDefaultTimeout(30_000);
async function fixture() {
	const result = await releaseFixture();
	fixtures.push(result);
	return result;
}
afterEach(async () => {
	for (const item of fixtures.splice(0)) await item.dispose();
});

test('a real prepared main ref update refuses an unversioned fast-forward without moving main', async () => {
	const f = await fixture();
	await f.write('src/app.ts', 'export const value=2;\n');
	const candidate = f.commit();
	f.git('config', 'core.hooksPath', resolve(import.meta.dir, '../.githooks'));
	const result = f.run('update-ref', 'refs/heads/main', candidate, f.base);
	expect(result.exitCode).not.toBe(0);
	expect(result.stderr.toString()).toContain('without a version bump');
	expect(f.git('rev-parse', 'main')).toBe(f.base);
	expect(f.git('rev-parse', 'candidate')).toBe(candidate);
});

test('the same real hook allows a versioned fast-forward and leaves other refs intact', async () => {
	const f = await fixture();
	await f.version('0.2.0');
	await f.write('src/app.ts', 'export const value=2;\n');
	const candidate = f.commit();
	f.git('config', 'core.hooksPath', resolve(import.meta.dir, '../.githooks'));
	const result = f.run('update-ref', 'refs/heads/main', candidate, f.base);
	expect(result.exitCode).toBe(0);
	expect(f.git('rev-parse', 'main')).toBe(candidate);
	expect(f.git('rev-parse', 'candidate')).toBe(candidate);
});

test('a non-main transaction is not turned into a release policy', async () => {
	const f = await fixture();
	await f.write('src/app.ts', 'export const value=2;\n');
	const candidate = f.commit();
	f.git('config', 'core.hooksPath', resolve(import.meta.dir, '../.githooks'));
	expect(f.run('update-ref', 'refs/heads/unreviewed-fixture', candidate).exitCode).toBe(0);
	expect(f.git('rev-parse', 'main')).toBe(f.base);
});

test('main deletion refuses instead of losing the release baseline', async () => {
	const f = await fixture();
	f.git('config', 'core.hooksPath', resolve(import.meta.dir, '../.githooks'));
	expect(f.run('update-ref', '-d', 'refs/heads/main').exitCode).not.toBe(0);
	expect(f.git('rev-parse', 'main')).toBe(f.base);
});

test('same-value main updates and pack-refs preserve the effective main identity', async () => {
	const f = await fixture();
	f.git('config', 'core.hooksPath', resolve(import.meta.dir, '../.githooks'));
	expect(f.run('update-ref', 'refs/heads/main', f.base).exitCode).toBe(0);
	expect(f.run('pack-refs', '--all').exitCode).toBe(0);
	expect(f.git('rev-parse', 'refs/heads/main')).toBe(f.base);
	expect(await Bun.file(join(f.root, '.git/refs/heads/main')).exists()).toBe(false);
	expect(await Bun.file(join(f.root, '.git/packed-refs')).text()).toContain(
		`${f.base} refs/heads/main`,
	);
	expect(f.run('update-ref', 'refs/heads/main', f.base).exitCode).toBe(0);
});

test('garbage collection preserves main and finishes without hook refusal', async () => {
	const f = await fixture();
	f.git('config', 'core.hooksPath', resolve(import.meta.dir, '../.githooks'));
	const result = f.run('gc', '--quiet');
	expect(result.exitCode).toBe(0);
	expect(result.stderr.toString()).not.toContain('hook');
	expect(f.git('rev-parse', 'refs/heads/main')).toBe(f.base);
});

test('real main deletion is refused for packed-only and packed-plus-loose refs', async () => {
	const f = await fixture();
	f.git('pack-refs', '--all');
	await f.version('0.2.0');
	const candidate = f.commit();
	f.git('config', 'core.hooksPath', resolve(import.meta.dir, '../.githooks'));
	expect(f.run('update-ref', '-d', 'refs/heads/main').exitCode).not.toBe(0);
	expect(f.git('rev-parse', 'refs/heads/main')).toBe(f.base);
	expect(f.run('update-ref', 'refs/heads/main', candidate, f.base).exitCode).toBe(0);
	expect(await Bun.file(join(f.root, '.git/refs/heads/main')).exists()).toBe(true);
	expect(f.run('update-ref', '-d', 'refs/heads/main').exitCode).not.toBe(0);
	expect(f.git('rev-parse', 'refs/heads/main')).toBe(candidate);
});

test('main creation is refused when no published baseline exists', async () => {
	const f = await fixture();
	f.git('update-ref', '-d', 'refs/heads/main');
	f.git('config', 'core.hooksPath', resolve(import.meta.dir, '../.githooks'));
	expect(f.run('update-ref', 'refs/heads/main', f.base).exitCode).not.toBe(0);
	expect(f.git('for-each-ref', '--format=%(refname)', 'refs/heads/main')).toBe('');
});

test('an update without an expected old value still checks behavior and refuses rewind', async () => {
	const f = await fixture();
	await f.write('src/app.ts', 'export const value=2;\n');
	const bad = f.commit();
	await f.version('0.2.0');
	const good = f.commit();
	f.git('config', 'core.hooksPath', resolve(import.meta.dir, '../.githooks'));
	expect(f.run('update-ref', 'refs/heads/main', bad).exitCode).not.toBe(0);
	expect(f.git('rev-parse', 'refs/heads/main')).toBe(f.base);
	expect(f.run('update-ref', 'refs/heads/main', good).exitCode).toBe(0);
	expect(f.run('update-ref', 'refs/heads/main', f.base).exitCode).not.toBe(0);
	expect(f.git('rev-parse', 'refs/heads/main')).toBe(good);
});
