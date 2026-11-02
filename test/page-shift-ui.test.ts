import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mailHarness } from './fixtures/mail-harness.ts';

/**
 * C14: the real page-shift watcher in a real Chromium page records the root and body moving on
 * either axis, once per episode, ignores an inner pane scrolling, names the focused element, and
 * sends each changed layout to the main process (morgan and morticia on df84bdd).
 */
test('the page-shift watcher sees root and body on both axes and nothing else', async () => {
	const fixture = await mailHarness();
	try {
		for (const [name, target] of [
			['page-shift-renderer', 'browser'],
			['page-shift-electron', 'node'],
		] as const) {
			const built = await Bun.build({
				entrypoints: [fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url))],
				outdir: fixture.root,
				target,
				naming: '[name].mjs',
				external: ['electron'],
			});
			expect(built.success).toBe(true);
		}
		await writeFile(
			join(fixture.root, 'page-shift.html'),
			'<html><body><script type="module" src="page-shift-renderer.mjs"></script></body></html>',
		);
		const electronRoot = fileURLToPath(new URL('../node_modules/electron/', import.meta.url));
		const executable = join(
			electronRoot,
			'dist',
			(await readFile(join(electronRoot, 'path.txt'), 'utf8')).trim(),
		);
		const env: NodeJS.ProcessEnv = { ...process.env, SUMMON_HOME: fixture.records };
		delete env.ELECTRON_RUN_AS_NODE;
		const spawnedAt = Date.now();
		const child = Bun.spawn(
			[executable, join(fixture.root, 'page-shift-electron.mjs'), fixture.root],
			{ env, stdout: 'pipe', stderr: 'pipe', windowsHide: true },
		);
		const deadline = setTimeout(() => child.kill(), 12000);
		try {
			const [code, out, error] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			// A failure says how far Electron got and what it wrote; the assertions are unchanged.
			if (code !== 0 || !out.includes('PAGE_SHIFT_PASS')) {
				const trace = await readFile(join(fixture.root, 'trace.txt'), 'utf8').catch(
					() => '(no trace: the fixture never started)',
				);
				console.error(
					`page-shift Electron: exit ${String(code)} after ${String(Date.now() - spawnedAt)} ms\nstdout ${JSON.stringify(out)}\nstderr ${JSON.stringify(error)}\ntrace:\n${trace}`,
				);
			}
			expect({ code, error: code ? error : '' }).toEqual({ code: 0, error: '' });
			expect(out).toContain('PAGE_SHIFT_PASS');
		} finally {
			clearTimeout(deadline);
			child.kill();
			await child.exited;
		}
	} finally {
		await fixture.dispose();
	}
}, 20000);
