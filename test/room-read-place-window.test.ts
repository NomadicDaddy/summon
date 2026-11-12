import { expect, test } from 'bun:test';
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Room restores and pages a saved place in a disposable Electron window', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-room-place-'));
	const desktop = fileURLToPath(new URL('../src/desktop/', import.meta.url));
	try {
		for (const name of await readdir(desktop)) {
			if (name.endsWith('.css') || name === 'index.html')
				await copyFile(join(desktop, name), join(root, name));
		}
		for (const [entry, target] of [
			['./fixtures/room-read-place-renderer.ts', 'browser'],
			['./fixtures/room-read-place-electron.ts', 'node'],
			['../src/desktop/theme-boot.ts', 'browser'],
		] as const) {
			const result = await Bun.build({
				entrypoints: [fileURLToPath(new URL(entry, import.meta.url))],
				outdir: root,
				target,
				naming: '[name].mjs',
				external: ['electron'],
			});
			expect(result.success).toBe(true);
		}
		await Bun.write(
			join(root, 'renderer.js'),
			await Bun.file(join(root, 'room-read-place-renderer.mjs')).text(),
		);
		await Bun.write(
			join(root, 'theme-boot.js'),
			await Bun.file(join(root, 'theme-boot.mjs')).text(),
		);
		const electronRoot = fileURLToPath(new URL('../node_modules/electron/', import.meta.url));
		const executable = join(
			electronRoot,
			'dist',
			(await readFile(join(electronRoot, 'path.txt'), 'utf8')).trim(),
		);
		const record = process.env['ROOM_PLACE_RECORD'];
		const env = { ...process.env };
		delete env.ELECTRON_RUN_AS_NODE;
		const child = Bun.spawn(
			[
				executable,
				join(root, 'room-read-place-electron.mjs'),
				root,
				...(record ? [record] : []),
			],
			{
				env,
				stdout: Bun.file(join(root, 'stdout.txt')),
				stderr: Bun.file(join(root, 'stderr.txt')),
				windowsHide: true,
			},
		);
		try {
			const code = await Promise.race([
				child.exited,
				new Promise<number>((_, reject) =>
					setTimeout(() => reject(new Error('Electron Room fixture timed out.')), 20000),
				),
			]).catch(async (cause: unknown) => {
				const progress = (await Bun.file(join(root, 'progress.txt')).exists())
					? await Bun.file(join(root, 'progress.txt')).text()
					: 'no progress';
				const stderr = (await Bun.file(join(root, 'stderr.txt')).exists())
					? await Bun.file(join(root, 'stderr.txt')).text()
					: '';
				throw new Error(`${String(cause)} at ${progress}: ${stderr}`);
			});
			const error = (await Bun.file(join(root, 'error.txt')).exists())
				? await Bun.file(join(root, 'error.txt')).text()
				: '';
			const stderr = await Bun.file(join(root, 'stderr.txt')).text();
			expect({ code, error, stderr }).toEqual({ code: 0, error: '', stderr: '' });
			const measured = JSON.parse(await Bun.file(join(root, 'result.json')).text()) as {
				views: {
					theme: string;
					width: number;
					height: number;
					clientWidth: number;
					scrollWidth: number;
				}[];
			};
			expect(
				measured.views.map(({ theme, width, height }) => ({ theme, width, height })),
			).toEqual([
				{ theme: 'dark', width: 2250, height: 1309 },
				{ theme: 'light', width: 2250, height: 1309 },
				{ theme: 'dark', width: 1440, height: 900 },
				{ theme: 'light', width: 1440, height: 900 },
			]);
			expect(measured.views.every((view) => view.scrollWidth <= view.clientWidth)).toBe(true);
		} finally {
			child.kill();
			await child.exited;
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 60000);
