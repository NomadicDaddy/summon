import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';

import { runtimePrerequisites } from '../src/runtime-prerequisites.ts';

const manifestSchema = z.object({
	buildBun: z.string(),
	prerequisites: z.array(
		z.object({ id: z.string(), minimumVersion: z.string(), installUrl: z.string() }),
	),
	files: z.array(
		z.object({
			path: z.string(),
			sha256: z.string().regex(/^[a-f0-9]{64}$/),
			bytes: z.number().int().nonnegative(),
		}),
	),
});

const required = [
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
];

export async function checkInstallerPayload(payload: string): Promise<number> {
	const manifest = manifestSchema.parse(
		JSON.parse(await readFile(join(payload, 'installer-build.json'), 'utf8')) as unknown,
	);
	for (const prerequisite of runtimePrerequisites)
		if (
			!manifest.prerequisites.some(
				(item) =>
					item.id === prerequisite.id &&
					item.minimumVersion === prerequisite.minimumVersion &&
					item.installUrl === prerequisite.installUrl,
			)
		)
			throw new Error(`Missing external prerequisite metadata: ${prerequisite.id}`);
	const expected = new Map<string, (typeof manifest.files)[number]>();
	for (const file of manifest.files) {
		const path = resolve(payload, file.path);
		const local = relative(payload, path);
		if (
			!local ||
			local.startsWith('..') ||
			isAbsolute(local) ||
			file.path !== local.replaceAll('\\', '/') ||
			expected.has(file.path.toLowerCase())
		)
			throw new Error(`Invalid or duplicate manifest path: ${file.path}`);
		expected.set(file.path.toLowerCase(), file);
	}
	for (const file of required)
		if (!expected.has(file.toLowerCase()))
			throw new Error(`Missing library/launch asset: ${file}`);
	const seen = new Set<string>();
	for (const entry of await readdir(payload, { recursive: true, withFileTypes: true })) {
		const path = join(entry.parentPath, entry.name);
		const local = relative(payload, path).replaceAll('\\', '/');
		if (entry.isSymbolicLink()) throw new Error(`Linked payload path refused: ${local}`);
		if (
			local.split('/')[0]?.toLowerCase() === 'runtime' ||
			(entry.isFile() &&
				/^(?:bun|node|pwsh|powershell|claude|codex|grok|kilo)(?:\.exe|\.cmd|\.bat)?$/i.test(
					basename(local),
				))
		)
			throw new Error(`Bundled runtime/shell/CLI refused: ${local}`);
		if (!entry.isFile() || local === 'installer-build.json') continue;
		const file = expected.get(local.toLowerCase());
		if (!file) throw new Error(`Unmanifested payload file: ${local}`);
		const content = await readFile(path);
		if (
			content.length !== file.bytes ||
			createHash('sha256').update(content).digest('hex') !== file.sha256
		)
			throw new Error(`Payload mismatch: ${local}`);
		seen.add(local.toLowerCase());
	}
	if (seen.size !== expected.size) throw new Error('Manifest contains absent payload files.');
	return seen.size;
}
