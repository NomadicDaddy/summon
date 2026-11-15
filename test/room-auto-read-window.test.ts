import { expect, test } from 'bun:test';
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reading moves the Room read marker (Phillip #46659, amended #51167 on #51137): one second fully
// on screen while the Room is open and the Window attends; an unbroken run only; the bottom of the
// live Room reads everything; never backwards. The fixture throws on the first case that fails.
test('Room reading advances the read marker under its stated conditions', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-room-auto-read-'));
	const desktop = fileURLToPath(new URL('../src/desktop/', import.meta.url));
	try {
		for (const name of await readdir(desktop)) {
			if (name.endsWith('.css') || name === 'index.html')
				await copyFile(join(desktop, name), join(root, name));
		}
		for (const [entry, target] of [
			['./fixtures/room-auto-read-renderer.ts', 'browser'],
			['./fixtures/room-auto-read-electron.ts', 'node'],
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
			await Bun.file(join(root, 'room-auto-read-renderer.mjs')).text(),
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
		const child = Bun.spawn([executable, join(root, 'room-auto-read-electron.mjs'), root], {
			env,
			stdout: Bun.file(join(root, 'stdout.txt')),
			stderr: Bun.file(join(root, 'stderr.txt')),
			windowsHide: true,
		});
		try {
			const code = await Promise.race([
				child.exited,
				new Promise<number>((_, reject) =>
					setTimeout(
						() => reject(new Error('Electron auto-read fixture timed out.')),
						45000,
					),
				),
			]).catch(async (cause: unknown) => {
				const progress = (await Bun.file(join(root, 'progress.txt')).exists())
					? await Bun.file(join(root, 'progress.txt')).text()
					: 'no progress';
				throw new Error(`${String(cause)} at ${progress}`);
			});
			const error = (await Bun.file(join(root, 'error.txt')).exists())
				? await Bun.file(join(root, 'error.txt')).text()
				: '';
			const stderr = await Bun.file(join(root, 'stderr.txt')).text();
			expect({ code, error, stderr }).toEqual({ code: 0, error: '', stderr: '' });
			const steps = JSON.parse(await Bun.file(join(root, 'result.json')).text()) as {
				closed: number;
				unfocused: number;
				fastScroll: number;
				bottom: { marker: number; badge: string };
				scrolledUp: { posted: number; marker: number };
				reached: number;
				neverBack: number;
			};
			expect(steps.closed).toBe(100);
			expect(steps.unfocused).toBe(100);
			expect(steps.fastScroll).toBe(100);
			expect(steps.bottom).toEqual({ marker: 450, badge: '' });
			expect(steps.scrolledUp).toEqual({ posted: 451, marker: 450 });
			expect(steps.reached).toBe(451);
			expect(steps.neverBack).toBe(451);
		} finally {
			child.kill();
			await child.exited;
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 90000);
