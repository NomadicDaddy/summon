import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { releaseFixture } from './fixtures/release-version-fixture.ts';

const fixtures: Awaited<ReturnType<typeof releaseFixture>>[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

async function run(outcome: string, version = '7.1.1', stream = 'stdout') {
	const fixture = await releaseFixture();
	fixtures.push(fixture);
	await fixture.write(
		'package.json',
		JSON.stringify({ version: '0.1.0', packageManager: `bun@${Bun.version}` }),
	);
	for (const path of [
		'installer/prerequisite-sources.json',
		'scripts/build-installer.ts',
		'scripts/installer-command.ts',
		'scripts/installer-launcher.ts',
		'src/executable.ts',
		'src/prerequisite-sources.ts',
		'src/runtime-prerequisites.ts',
	]) {
		await mkdir(join(fixture.root, path.split('/')[0] ?? ''), { recursive: true });
		await copyFile(resolve(import.meta.dir, '..', path), join(fixture.root, path));
	}
	const child = Bun.spawnSync(
		[
			process.execPath,
			fileURLToPath(new URL('./fixtures/installer-version-runner.ts', import.meta.url)),
			fixture.root,
			outcome,
			version,
			stream,
		],
		{ cwd: fixture.root, windowsHide: true, timeout: 10_000 },
	);
	return {
		root: fixture.root,
		child,
		buildReached: await Bun.file(join(fixture.root, 'build-reached.json')).exists(),
		payloadCreated: existsSync(join(fixture.root, 'dist/installer')),
	};
}

const windowsX64 = process.platform === 'win32' && process.arch === 'x64';
for (const outcome of [
	'nonzero',
	'signal',
	'unsuccessful',
	'unavailable',
	'inconsistent-exit',
	'inconsistent-signal',
]) {
	test.skipIf(!windowsX64)(
		`installer refuses ${outcome} version result before staging`,
		async () => {
			const result = await run(outcome);
			expect(result.child.exitCode).not.toBe(0);
			expect(result.child.stderr.toString()).toContain(
				outcome === 'unavailable'
					? 'Synthetic compiler unavailable'
					: 'did not complete successfully',
			);
			expect(result.buildReached).toBe(false);
			expect(result.payloadCreated).toBe(false);
			if (outcome !== 'unavailable') {
				const evidence: unknown = JSON.parse(result.child.stdout.toString().trim());
				expect(evidence).toMatchObject({
					stage: 'compiler-version',
					exitCode: outcome === 'nonzero' || outcome === 'inconsistent-exit' ? 7 : 0,
					stdout: '7.1.1',
					stderr: '',
					success: outcome.startsWith('inconsistent-'),
					signalCode:
						outcome === 'signal' || outcome === 'inconsistent-signal'
							? 'SIGTERM'
							: null,
				});
			}
		},
	);
}

for (const version of ['7.1.0', '7.1.1-beta', '7.1.10', 'prefix 7.1.1', '7.0.0', '']) {
	test.skipIf(!windowsX64)(
		`installer refuses successful unpinned version ${version}`,
		async () => {
			const result = await run('success', version);
			expect(result.child.exitCode).not.toBe(0);
			expect(result.child.stderr.toString()).toContain(
				'Use the pinned Inno Setup 7.1.1 compiler',
			);
			expect(result.buildReached).toBe(false);
			expect(result.payloadCreated).toBe(false);
		},
	);
}

for (const stream of ['stdout', 'stderr']) {
	test.skipIf(!windowsX64)(
		`installer accepts stable version on ${stream} before build`,
		async () => {
			const result = await run('success', '7.1.1\r\n', stream);
			expect(result.child.stderr.toString()).toContain('Controlled build boundary');
			expect(result.buildReached).toBe(true);
			const command: unknown = await Bun.file(join(result.root, 'build-reached.json')).json();
			expect(command).toEqual([process.execPath, 'run', 'build:team']);
			expect(await readdir(join(result.root, 'dist/installer'))).toHaveLength(1);
			const evidence: unknown = JSON.parse(result.child.stdout.toString().trim());
			expect(evidence).toMatchObject({
				stage: 'compiler-version',
				exitCode: 0,
				success: true,
			});
		},
	);
}
