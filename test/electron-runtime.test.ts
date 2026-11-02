import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { assertElectronRuntime } from '../src/electron-runtime.ts';

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-electron-version-'));
	await mkdir(join(root, 'dist'));
	await writeFile(join(root, 'package.json'), JSON.stringify({ version: '44.5.0' }));
});
afterEach(async () => {
	if (
		dirname(root) !== resolve(tmpdir()) ||
		!basename(root).startsWith('summon-electron-version-')
	)
		throw new Error('Unexpected Electron fixture directory.');
	await rm(root, { recursive: true, force: true });
});

test('matching runtime versions accept normalized version-file whitespace and prefix', async () => {
	for (const version of ['44.5.0', 'v44.5.0\n']) {
		await writeFile(join(root, 'dist', 'version'), version);
		await assertElectronRuntime(root);
	}
});

test('mismatch and missing runtime refuse with versions and operator repair instructions', async () => {
	for (const version of [undefined, '44.4.5']) {
		if (version) await writeFile(join(root, 'dist', 'version'), version);
		const error = await assertElectronRuntime(root).catch(String);
		expect(error).toContain(version ?? 'missing');
		expect(error).toContain('44.5.0');
		expect(error).toContain('Close all Summon Team Windows');
		expect(error).toContain('bun scripts/install-electron.ts');
	}
});

test('installer wrapper preserves child failure and reports the Windows lock recovery', async () => {
	const scripts = join(root, 'scripts');
	const packageRoot = join(root, 'node_modules', 'electron');
	await mkdir(scripts);
	await mkdir(packageRoot, { recursive: true });
	await writeFile(
		join(packageRoot, 'package.json'),
		JSON.stringify({ name: 'electron', version: '44.5.0' }),
	);
	await writeFile(join(packageRoot, 'install.js'), 'process.exit(7);');
	const wrapper = join(scripts, 'install-electron.ts');
	await writeFile(wrapper, await readFile(resolve('scripts/install-electron.ts'), 'utf8'));
	const child = Bun.spawn([process.execPath, wrapper], {
		stdout: 'pipe',
		stderr: 'pipe',
		stdin: 'ignore',
		windowsHide: true,
	});
	const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	expect(code).toBe(7);
	expect(error).toContain('Electron runtime was not installed');
	expect(error).toContain('close all Team Windows');
});
