import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('checkpoint Claude submits with its production timer in Electron without Bun', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-claude-electron-'));
	try {
		const build = await Bun.build({
			entrypoints: [
				fileURLToPath(new URL('./fixtures/claude-electron-input.ts', import.meta.url)),
			],
			outdir: root,
			target: 'node',
		});
		expect(build.success).toBe(true);
		const electronRoot = fileURLToPath(new URL('../node_modules/electron/', import.meta.url));
		const executable = join(
			electronRoot,
			'dist',
			(await readFile(join(electronRoot, 'path.txt'), 'utf8')).trim(),
		);
		const child = Bun.spawn([executable, join(root, 'claude-electron-input.js')], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		try {
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
			expect(stdout).toContain('Electron notice submission passed without Bun.');
		} finally {
			child.kill();
			await child.exited;
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 15000);
