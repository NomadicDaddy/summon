import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { assertMediumIntegrity, assertNonElevated } from '../src/windows-integrity.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

test('integrity SID detects elevation across languages, not administrator membership', () => {
	expect(() =>
		assertMediumIntegrity('"Administrators","S-1-5-32-544"\n"Label","S-1-16-8192"'),
	).not.toThrow();
	for (const groups of ['Etiqueta S-1-16-12288', 'System S-1-16-16384'])
		expect(() => assertMediumIntegrity(groups)).toThrow('blocked an elevated');
	for (const groups of ['', 'whoami: extra operand', 'S-1-16-8192 S-1-16-12288'])
		expect(() => assertMediumIntegrity(groups)).toThrow('Cannot verify');
	expect(() => assertMediumIntegrity('S-1-16-4096')).toThrow('requires Windows Medium');
});

test('real Windows probe either verifies Medium or explicitly refuses; it never launches a GUI', async () => {
	try {
		await assertNonElevated();
	} catch (error) {
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(
			/blocked an elevated|Cannot verify|requires Windows/,
		);
	}
});

test('elevated CLI team, terminal and internal runner stop before any launch', async () => {
	const fixture = await mailHarness();
	try {
		for (const args of [['--team'], ['alpha'], ['all'], ['__session', 'alpha']]) {
			const child = Bun.spawn({
				cmd: [
					process.execPath,
					'--preload',
					join(import.meta.dir, 'fixtures/capture-launch.ts'),
					'--preload',
					join(import.meta.dir, 'fixtures/high-integrity.ts'),
					join(import.meta.dir, '../src/cli.ts'),
					...args,
				],
				env: {
					...process.env,
					SUMMON_HOME: fixture.records,
					SUMMON_AGENT: '',
					SUMMON_NONCE: '',
					CODEX_HOME: join(fixture.root, 'codex'),
					SUMMON_TEST_CAPTURE: fixture.capture,
				},
				stdout: 'pipe',
				stderr: 'pipe',
				stdin: 'ignore',
				windowsHide: true,
			});
			const [code, error] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
			]);
			expect(code).toBe(1);
			expect(error).toContain('blocked an elevated');
			expect(await Bun.file(fixture.capture).text()).toBe('');
		}
	} finally {
		await fixture.dispose();
	}
});

for (const mode of ['cli', 'direct'] as const) {
	test(`elevated ${mode} window entry leaves a fresh default store untouched`, async () => {
		const fixture = await mailHarness();
		try {
			const name = `fresh-${mode}`;
			const base = join(fixture.root, name);
			const entry =
				mode === 'cli'
					? [join(import.meta.dir, '../src/cli.ts'), '--team']
					: [join(import.meta.dir, 'fixtures/window-storage-argv.ts'), '--open'];
			const child = Bun.spawn({
				cmd: [
					process.execPath,
					'--preload',
					join(import.meta.dir, 'fixtures/capture-launch.ts'),
					'--preload',
					join(import.meta.dir, 'fixtures/high-integrity.ts'),
					...entry,
				],
				env: {
					...process.env,
					SUMMON_HOME: mode === 'cli' ? '' : join(base, 'team-default'),
					SUMMON_TEAMS_HOME: base,
					SUMMON_AGENT: '',
					SUMMON_NONCE: '',
					CODEX_HOME: join(fixture.root, 'codex'),
					SUMMON_TEST_CAPTURE: fixture.capture,
				},
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				windowsHide: true,
			});
			const [code, error] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
			]);
			expect(code).toBe(1);
			expect(error).toContain('blocked an elevated');
			expect(await readdir(fixture.root)).not.toContain(name);
			expect(await Bun.file(fixture.capture).text()).toBe('');
		} finally {
			await fixture.dispose();
		}
	});
}
