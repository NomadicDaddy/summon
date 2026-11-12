import { expect, test } from 'bun:test';
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Phillip #44366: scrolled up a little in Team Room, a new post jumped him to the bottom. Only a
// reader actually at the bottom follows new posts; any reader scrolled up keeps the post they were
// reading at the top of the view, measured in a disposable Electron window.
test('a new Room post moves only a reader who is at the bottom', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-room-follow-'));
	const desktop = fileURLToPath(new URL('../src/desktop/', import.meta.url));
	try {
		for (const name of await readdir(desktop)) {
			if (name.endsWith('.css') || name === 'index.html')
				await copyFile(join(desktop, name), join(root, name));
		}
		for (const [entry, target] of [
			['./fixtures/room-follow-renderer.ts', 'browser'],
			['./fixtures/room-follow-electron.ts', 'node'],
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
			await Bun.file(join(root, 'room-follow-renderer.mjs')).text(),
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
		const env = { ...process.env };
		delete env.ELECTRON_RUN_AS_NODE;
		const child = Bun.spawn([executable, join(root, 'room-follow-electron.mjs'), root], {
			env,
			stdout: Bun.file(join(root, 'stdout.txt')),
			stderr: Bun.file(join(root, 'stderr.txt')),
			windowsHide: true,
		});
		const code = await Promise.race([
			child.exited,
			new Promise<number>((_, reject) =>
				setTimeout(
					() => reject(new Error('Electron Room follow fixture timed out.')),
					30000,
				),
			),
		]);
		const error = (await Bun.file(join(root, 'error.txt')).exists())
			? await Bun.file(join(root, 'error.txt')).text()
			: '';
		expect({ code, error }).toEqual({ code: 0, error: '' });
		const rows = JSON.parse(await Bun.file(join(root, 'result.json')).text()) as {
			distance: number | 'scrolled-during-read';
			before: { fromBottom: number; topPost: string };
			after: { fromBottom: number; topPost: string };
		}[];
		console.log(JSON.stringify(rows));
		for (const { distance, before, after } of rows) {
			if (distance === 0)
				expect({ distance, fromBottom: after.fromBottom }).toEqual({
					distance,
					fromBottom: 0,
				});
			else
				expect({ distance, topPost: after.topPost }).toEqual({
					distance,
					topPost: before.topPost,
				});
		}
	} finally {
		await rm(root, { force: true, recursive: true });
	}
}, 60000);
