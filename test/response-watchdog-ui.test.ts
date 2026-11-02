import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mailHarness } from './fixtures/mail-harness.ts';

test('isolated Chromium alert preserves focus, shows bounds, and never selects provider input', async () => {
	const fixture = await mailHarness();
	try {
		for (const [name, target] of [
			['response-watchdog-renderer', 'browser'],
			['response-watchdog-electron', 'node'],
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
		const css = await readFile(
			new URL('../src/desktop/response-watchdog.css', import.meta.url),
			'utf8',
		);
		await writeFile(
			join(fixture.root, 'watchdog.html'),
			`<html><head><style>body{width:252px;--warn-fill-text:#865600}${css}</style></head><body><script type="module" src="response-watchdog-renderer.mjs"></script></body></html>`,
		);
		const electronRoot = fileURLToPath(new URL('../node_modules/electron/', import.meta.url));
		const executable = join(
			electronRoot,
			'dist',
			(await readFile(join(electronRoot, 'path.txt'), 'utf8')).trim(),
		);
		const env: NodeJS.ProcessEnv = { ...process.env, SUMMON_HOME: fixture.records };
		delete env.ELECTRON_RUN_AS_NODE;
		const child = Bun.spawn(
			[executable, join(fixture.root, 'response-watchdog-electron.mjs'), fixture.root],
			{
				env,
				stdout: 'pipe',
				stderr: 'pipe',
				windowsHide: true,
			},
		);
		const deadline = setTimeout(() => child.kill(), 10000);
		try {
			const [code, out, error] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect({ code, error: code ? error : '' }).toEqual({ code: 0, error: '' });
			expect(out).toContain('WATCHDOG_UI_PASS');
		} finally {
			clearTimeout(deadline);
			child.kill();
			await child.exited;
		}
	} finally {
		await fixture.dispose();
	}
}, 20000);
