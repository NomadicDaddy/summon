import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { MaintenanceHost, MaintenanceState } from '../src/maintenance-update.ts';

import { maintainInstallation } from '../src/maintenance-update.ts';
import { checkReleaseVersion, checkWorkingReleaseVersion } from '../src/release-version.ts';
import { requireCompatibleTeamLayout } from '../src/storage-layout.ts';
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

test('the maintenance transaction rolls back through the real guard at a historical Git commit', async () => {
	const f = await fixture();
	for (const name of [
		'release-candidate.ts',
		'release-changelog.ts',
		'release-version.ts',
		'release-version-git.ts',
		'executable.ts',
	])
		await copyFile(resolve(import.meta.dir, '../src', name), join(f.root, 'src', name));
	await f.write(
		'scripts/check-release-version.ts',
		await Bun.file(resolve(import.meta.dir, '../scripts/check-release-version.ts')).text(),
	);
	await f.version('0.2.0');
	const previous = f.commit('guarded release');
	await f.version('0.3.0');
	await f.write('src/app.ts', 'export const value=3;\n');
	const current = f.commit('later release');
	f.git('update-ref', 'refs/heads/main', current, f.base);
	f.git('switch', '--quiet', 'main');
	const olderBuild = { commit: previous, version: '0.2.0', buildId: '0123456789' };
	const newerBuild = { commit: current, version: '0.3.0', buildId: 'abcdef0123' };
	let installed = newerBuild;
	let state: MaintenanceState = { version: 1, current: newerBuild, previous: olderBuild };
	const checks: string[] = [];
	const runGuard = () => {
		const result = Bun.spawnSync(
			[process.execPath, join(f.root, 'scripts/check-release-version.ts')],
			{ cwd: f.root, windowsHide: true, timeout: 20_000 },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe('');
		const output: unknown = JSON.parse(result.stdout.toString());
		expect(output).toMatchObject({
			base: current,
			candidate: previous,
			baseline: previous,
			version: '0.2.0',
			reason: 'clean historical main rebuild; test/documentation-only',
		});
	};
	const host: MaintenanceHost = {
		readState: () => Promise.resolve(state),
		writeState: (next) => {
			state = next;
			return Promise.resolve();
		},
		installed: () => Promise.resolve(installed),
		main: () => Promise.resolve(f.git('rev-parse', 'refs/heads/main')),
		preflight: () => Promise.resolve(),
		compatible: async (pin) => {
			expect(pin).toBe(previous);
			expect(state.pending).toBeUndefined();
			await requireCompatibleTeamLayout(join(f.root, 'team-store'), undefined);
			checks.push('layout preflight');
		},
		offline: () => Promise.resolve(),
		checkout: (pin, rollback) => {
			expect(rollback).toBe(true);
			f.git('switch', '--quiet', '--detach', pin);
			return Promise.resolve();
		},
		assertCheckout: (pin, main, rollback) => {
			expect(f.git('rev-parse', 'HEAD')).toBe(pin);
			expect(f.git('rev-parse', 'refs/heads/main')).toBe(main);
			expect(f.git('branch', '--show-current')).toBe(rollback ? '' : 'main');
			expect(f.git('status', '--porcelain=v1', '--untracked-files=all')).toBe('');
			return Promise.resolve();
		},
		install: () => Promise.resolve(),
		build: () => {
			runGuard();
			checks.push('build preflight');
			installed = olderBuild;
			return Promise.resolve();
		},
		gate: () => {
			runGuard();
			checks.push('gate preflight');
			return Promise.resolve();
		},
	};
	const result = await maintainInstallation(host, true);
	expect(result).toMatchObject({ current: olderBuild, previous: newerBuild });
	expect(result.pending).toBeUndefined();
	expect(checks).toEqual(['layout preflight', 'build preflight', 'gate preflight']);
	expect(f.git('rev-parse', 'HEAD')).toBe(previous);
	expect(f.git('rev-parse', 'refs/heads/main')).toBe(current);
	await rejects(checkReleaseVersion(f.root, current, previous));
	// The real transaction, Git checkout and guard CLI run here. Package installation,
	// artifact production, offline ownership and a full app gate remain fixture host operations.
});

for (const mode of ['staged', 'unstaged', 'untracked']) {
	test(`historical rebuilds refuse ${mode} changes`, async () => {
		const f = await fixture();
		await f.version('0.2.0');
		const historical = f.commit();
		await f.version('0.3.0');
		const current = f.commit();
		f.git('update-ref', 'refs/heads/main', current, f.base);
		f.git('switch', '--quiet', '--detach', historical);
		if (mode === 'untracked')
			await f.write(
				'docs/untracked.md',
				'Even documentation needs a clean historical checkout.\n',
			);
		else {
			await f.write('src/app.ts', 'export const value=2;\n');
			if (mode === 'staged') f.git('add', 'src/app.ts');
		}
		await rejects(checkWorkingReleaseVersion(f.root), /historical.*clean/u);
		expect(f.git('rev-parse', 'HEAD')).toBe(historical);
		expect(f.git('rev-parse', 'refs/heads/main')).toBe(current);
	});
}

test('published ancestry does not excuse an inconsistent historical runtime tip', async () => {
	const f = await fixture();
	await f.write('src/app.ts', 'export const value=2;\n');
	const historical = f.commit();
	await f.version('0.2.0');
	const current = f.commit();
	f.git('update-ref', 'refs/heads/main', current, f.base);
	f.git('switch', '--quiet', '--detach', historical);
	await rejects(checkWorkingReleaseVersion(f.root), /without a version bump/u);
});

test('an unpublished same-version runtime candidate still refuses before and after commit', async () => {
	const f = await fixture();
	await f.write('src/app.ts', 'export const value=2;\n');
	await rejects(checkWorkingReleaseVersion(f.root), /without a version bump/u);
	const candidate = f.commit();
	await rejects(checkWorkingReleaseVersion(f.root), /without a version bump/u);
	await rejects(checkReleaseVersion(f.root, f.base, candidate), /without a version bump/u);
	expect(f.git('rev-parse', 'refs/heads/main')).toBe(f.base);
});
