import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mailHarness } from './fixtures/mail-harness.ts';

/**
 * The Team Window as a whole never scrolls (#12148). Page Up in a teammate's terminal let a focused
 * element below the window scroll the page, pushing every column into a strip at the top that no
 * key could undo. Real style.css and theme.css; a focused box 1,200px below the terminal area.
 */
test('focus below the window scrolls neither the page nor the terminal area', async () => {
	const fixture = await mailHarness();
	try {
		const built = await Bun.build({
			entrypoints: [
				fileURLToPath(new URL('./fixtures/window-clip-electron.ts', import.meta.url)),
			],
			outdir: fixture.root,
			target: 'node',
			naming: '[name].mjs',
			external: ['electron'],
		});
		expect(built.success).toBe(true);
		const css = await Promise.all(
			['theme.css', 'style.css'].map((name) =>
				readFile(new URL(`../src/desktop/${name}`, import.meta.url), 'utf8'),
			),
		);
		await writeFile(
			join(fixture.root, 'clip.html'),
			`<html><head><style>${css.join('\n')}</style></head><body><aside id="sidebar"></aside><main><div id="terminals"><div class="terminal-pane"></div><textarea id="below" style="position:absolute;left:0;top:2000px;width:10px;height:10px"></textarea></div></main></body></html>`,
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
			[executable, join(fixture.root, 'window-clip-electron.mjs'), fixture.root],
			{ env, stdout: 'pipe', stderr: 'pipe', windowsHide: true },
		);
		const deadline = setTimeout(() => child.kill(), 10000);
		try {
			const [code, out, error] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect({ code, error: code ? error : '' }).toEqual({ code: 0, error: '' });
			const line = out.split(/\r?\n/).find((text) => text.startsWith('WINDOW_CLIP ')) ?? '';
			expect(line).not.toBe('');
			expect(JSON.parse(line.slice('WINDOW_CLIP '.length))).toEqual({
				body: 0,
				bodyTop: 0,
				focused: true,
				page: 0,
				pageFits: true,
				terminals: 0,
			});
		} finally {
			clearTimeout(deadline);
			child.kill();
			await child.exited;
		}
	} finally {
		await fixture.dispose();
	}
}, 20000);
