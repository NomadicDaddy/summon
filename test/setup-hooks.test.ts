import { expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('explicit hook setup rejects non-checkouts and parent repositories, then configures its own root', async () => {
	const outer = await mkdtemp(join(tmpdir(), 'summon-hooks-'));
	const root = join(outer, 'source');
	try {
		await mkdir(join(root, 'scripts'), { recursive: true });
		await mkdir(join(root, 'src'));
		await mkdir(join(root, '.githooks'));
		for (const file of [
			'src/executable.ts',
			'scripts/setup-hooks.ts',
			'scripts/run-bash.ts',
			'.githooks/leak-guard-setup.sh',
		])
			await copyFile(resolve(file), join(root, file));
		const patterns = join(outer, 'patterns');
		await writeFile(patterns, '# disposable fixture\n');
		const invoke = async () => {
			const child = Bun.spawn([process.execPath, join(root, 'scripts/setup-hooks.ts')], {
				cwd: root,
				env: { ...process.env, LEAK_GUARD_PATTERNS: patterns },
				stdout: 'pipe',
				stderr: 'pipe',
				windowsHide: true,
			});
			const [code, error] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
			]);
			return { code, error };
		};
		const git = (cwd: string, args: string[]) =>
			Bun.spawnSync(['git', ...args], {
				cwd,
				stdout: 'pipe',
				stderr: 'pipe',
				windowsHide: true,
			});
		expect((await invoke()).error).toContain('requires a Git checkout');
		expect(git(outer, ['init', '--quiet']).exitCode).toBe(0);
		expect(git(outer, ['config', '--local', 'core.hooksPath', 'keep-hooks']).exitCode).toBe(0);
		expect((await invoke()).error).toContain('parent repository');
		expect(
			git(outer, ['config', '--local', '--get', 'core.hooksPath']).stdout.toString().trim(),
		).toBe('keep-hooks');
		expect(git(root, ['init', '--quiet']).exitCode).toBe(0);
		expect(await invoke()).toEqual({ code: 0, error: '' });
		expect(
			git(root, ['config', '--local', '--get', 'core.hooksPath']).stdout.toString().trim(),
		).toBe('.githooks');
		expect(
			git(outer, ['config', '--local', '--get', 'core.hooksPath']).stdout.toString().trim(),
		).toBe('keep-hooks');
	} finally {
		await rm(outer, { recursive: true, force: true });
	}
});
