import { expect } from 'bun:test';
import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mailHarness } from './mail-harness.ts';

/** One window size to measure the Board at, with the Room closed or open beside it. */
export interface BoardUiCase {
	height: number;
	room: boolean;
	width: number;
}

/**
 * Renders the real index.html with every stylesheet it links, the theme-boot script removed and
 * renderer.js replaced by a Board fixture, in an off-screen Electron window at each case's content
 * size, and returns what the fixture measured there, one record per case.
 * @param renderer The fixture under test/fixtures that sets up the Board and measures it.
 * @param marker The document.title prefix the fixture reports under.
 * @param cases The window sizes, in order.
 */
export async function measureBoardUi(
	renderer: string,
	marker: string,
	cases: BoardUiCase[],
): Promise<Record<string, unknown>[]> {
	const fixture = await mailHarness();
	try {
		for (const [name, target] of [
			[renderer, 'browser'],
			['board-ui-electron', 'node'],
		] as const) {
			const built = await Bun.build({
				entrypoints: [fileURLToPath(new URL(`./${name}.ts`, import.meta.url))],
				outdir: fixture.root,
				target,
				naming: '[name].mjs',
				external: ['electron'],
			});
			expect(built.success).toBe(true);
		}
		const desktop = fileURLToPath(new URL('../../src/desktop/', import.meta.url));
		for (const name of await readdir(desktop)) {
			if (name.endsWith('.css'))
				await copyFile(join(desktop, name), join(fixture.root, name));
		}
		const html = (await readFile(join(desktop, 'index.html'), 'utf8'))
			.replace('<script src="theme-boot.js"></script>', '')
			.replace('src="renderer.js"', `src="${renderer}.mjs"`);
		expect(html).toContain(`${renderer}.mjs`);
		await writeFile(join(fixture.root, 'index.html'), html);
		const electronRoot = fileURLToPath(
			new URL('../../node_modules/electron/', import.meta.url),
		);
		const executable = join(
			electronRoot,
			'dist',
			(await readFile(join(electronRoot, 'path.txt'), 'utf8')).trim(),
		);
		const env: NodeJS.ProcessEnv = { ...process.env, SUMMON_HOME: fixture.records };
		delete env.ELECTRON_RUN_AS_NODE;
		const child = Bun.spawn(
			[
				executable,
				join(fixture.root, 'board-ui-electron.mjs'),
				fixture.root,
				marker,
				JSON.stringify(cases),
			],
			{ env, stdout: 'pipe', stderr: 'pipe', windowsHide: true },
		);
		const deadline = setTimeout(() => child.kill(), 15000 + cases.length * 5000);
		try {
			const [code, out, error] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect({ code, error: code ? error : '' }).toEqual({ code: 0, error: '' });
			const measured = out
				.split(/\r?\n/u)
				.filter((line) => line.startsWith(`${marker} `))
				.map(
					(line) => JSON.parse(line.slice(marker.length + 1)) as Record<string, unknown>,
				);
			// Kept for review evidence when asked for: the measurements, before any assertion reads them.
			const record = process.env['BOARD_UI_RECORD'];
			if (record) await writeFile(join(record, `${marker}.json`), JSON.stringify(measured));
			return measured;
		} finally {
			clearTimeout(deadline);
			child.kill();
			await child.exited;
		}
	} finally {
		await fixture.dispose();
	}
}
