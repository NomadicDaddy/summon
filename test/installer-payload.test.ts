import { afterAll, expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { checkInstallerPayload } from '../scripts/installer-payload.ts';
import { runtimePrerequisites } from '../src/runtime-prerequisites.ts';

const root = await mkdtemp(join(tmpdir(), 'summon-payload-contract-'));
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

async function fixture() {
	const payload = join(root, crypto.randomUUID());
	for (const path of [
		'app/scripts/installed-launch.ts',
		'app/src/cli.ts',
		'app/src/runtime-prerequisites.ts',
		'app/dist/team/main.mjs',
		'app/dist/team/preload.cjs',
		'app/dist/team/renderer.js',
		'app/THIRD-PARTY-NOTICES.md',
		'app/node_modules/electron/path.txt',
		'app/node_modules/electron/LICENSE',
		'app/node_modules/electron/dist/electron.exe',
		'app/node_modules/electron/dist/LICENSE',
		'app/node_modules/electron/dist/LICENSES.chromium.html',
		'app/node_modules/electron/dist/icudtl.dat',
		'app/node_modules/electron/dist/resources.pak',
		'app/node_modules/node-pty/package.json',
		'app/node_modules/node-pty/LICENSE',
	]) {
		await mkdir(dirname(join(payload, path)), { recursive: true });
		await writeFile(join(payload, path), 'fixture only; never executed or distributed');
	}
	return payload;
}

async function manifest(payload: string) {
	const files: { path: string; bytes: number; sha256: string }[] = [];
	for (const entry of await readdir(payload, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile() || entry.name === 'installer-build.json') continue;
		const path = join(entry.parentPath, entry.name);
		const content = await readFile(path);
		files.push({
			path: path.slice(payload.length + 1).replaceAll('\\', '/'),
			bytes: content.length,
			sha256: createHash('sha256').update(content).digest('hex'),
		});
	}
	await writeFile(
		join(payload, 'installer-build.json'),
		JSON.stringify({ buildBun: '1.4.3', prerequisites: runtimePrerequisites, files }),
	);
}

test('payload check retains Electron/library license assets and verifies hashes', async () => {
	const payload = await fixture();
	await manifest(payload);
	expect(await checkInstallerPayload(payload)).toBe(16);
	await writeFile(join(payload, 'app/src/cli.ts'), 'tampered');
	await rejects(checkInstallerPayload(payload), /Payload mismatch/);
});

test('payload check refuses a runtime even when accurately included in the manifest', async () => {
	for (const name of [
		'runtime/bun/bun.exe',
		'app/node_modules/hidden/pwsh.exe',
		'app/node.exe',
	]) {
		const payload = await fixture();
		await mkdir(dirname(join(payload, name)), { recursive: true });
		await writeFile(join(payload, name), 'forbidden runtime fixture');
		await manifest(payload);
		await rejects(checkInstallerPayload(payload), /Bundled runtime\/shell\/CLI refused/);
	}
});

test('omitting Electron license material or adding an unmanifested file fails closed', async () => {
	const payload = await fixture();
	await rm(join(payload, 'app/node_modules/electron/dist/LICENSES.chromium.html'));
	await manifest(payload);
	await rejects(checkInstallerPayload(payload), /Missing library\/launch asset/);
	const extra = await fixture();
	await manifest(extra);
	await writeFile(join(extra, 'extra.txt'), 'unlisted');
	await rejects(checkInstallerPayload(extra), /Unmanifested payload file/);
});
