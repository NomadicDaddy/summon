import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('real renderer controls follow CLI checks and preserve per-provider preferences', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-filter-dom-'));
	try {
		for (const [entry, target] of [
			['provider-filter-dom', 'browser'],
			['provider-filter-electron', 'node'],
		] as const) {
			const result = await Bun.build({
				entrypoints: [join(import.meta.dir, 'fixtures', `${entry}.ts`)],
				outdir: root,
				target,
				external: ['electron'],
				naming: '[name].mjs',
			});
			expect(result.success).toBe(true);
		}
		await Bun.write(
			join(root, 'index.html'),
			'<!doctype html><html><body><script type="module" src="provider-filter-dom.mjs"></script></body></html>',
		);
		const electron =
			process.platform === 'win32'
				? join(import.meta.dir, '../node_modules/electron/dist/electron.exe')
				: process.platform === 'darwin'
					? join(
							import.meta.dir,
							'../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
						)
					: join(import.meta.dir, '../node_modules/electron/dist/electron');
		const child = Bun.spawn([electron, join(root, 'provider-filter-electron.mjs'), root], {
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
		});
		const timeout = setTimeout(() => child.kill(), 20000);
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		clearTimeout(timeout);
		expect({ code, error: code === 0 ? '' : err }).toEqual({ code: 0, error: '' });
		expect(out).toContain('"assertions":25');
		expect(out).toContain('"providers":["claude","codex","grok","kilo"]');
		expect(out).toContain('"presenceAssertions":16');
		expect(out).toContain('"restAssertions":16');
		expect(out).toContain('"runtimeAssertions":34');
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}, 30000);
