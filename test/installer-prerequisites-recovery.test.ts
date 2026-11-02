import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createHarness, type Fixture, helperRun } from './fixtures/prerequisite-helper.ts';

const windows = process.platform === 'win32' ? test : test.skip;
let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
beforeAll(async () => {
	if (process.platform === 'win32') harness = await createHarness();
}, 60_000);
afterAll(async () => {
	await harness?.stop();
}, 40_000);

function use() {
	if (!harness) throw new Error('The prerequisite helper harness is Windows-only.');
	return harness;
}

// Fault injection replaces only the copy dependency. The complete production helper still
// downloads, verifies, stages, publishes and cleans up inside the isolated fixture paths.
async function copyFault(where: Fixture, body: string): Promise<string> {
	const source = await readFile(
		resolve(import.meta.dir, '../installer/prerequisites.ps1'),
		'utf8',
	);
	const marker = 'function Install-Fallback(';
	expect(source.split(marker)).toHaveLength(2);
	const shim = `function Copy-Item {
param([string]$Path, [string]$Destination, [switch]$Recurse, [switch]$Force)
${body}
}
`;
	const path = join(where.base, 'copy-fault.ps1');
	await writeFile(path, source.replace(marker, `${shim}${marker}`));
	return path;
}

windows(
	'a partial PowerShell copy never occupies the final version folder and can retry',
	async () => {
		const where = await use().fixture();
		const script = await copyFault(
			where,
			`
[IO.File]::WriteAllText((Join-Path $Destination 'partial.dll'), 'partial')
throw 'simulated interrupted copy'
`,
		);
		const first = await helperRun(where, 'install', { id: 'pwsh', helperScript: script });
		expect(first).toMatchObject({ outcome: 'failed', route: 'fallback' });
		expect(first.detail).toContain('%LOCALAPPDATA%\\Programs\\PowerShell\\7.6.9');
		const parent = join(where.local, 'Programs', 'PowerShell');
		expect(await readdir(parent)).toEqual([]);
		expect(await Bun.file(where.pathStore).exists()).toBe(false);
		expect(await helperRun(where, 'install', { id: 'pwsh' })).toMatchObject({
			outcome: 'installed',
			version: '7.6.9',
		});
		expect(await readdir(parent)).toEqual(['7.6.9']);
	},
);

windows('a version folder appearing during copy is preserved and staging is removed', async () => {
	const where = await use().fixture();
	const script = await copyFault(
		where,
		`
Microsoft.PowerShell.Management\\Copy-Item -Path $Path -Destination $Destination -Recurse -Force
$occupied = Join-Path (Split-Path -Parent $Destination) '7.6.9'
New-Item -ItemType Directory -Path $occupied | Out-Null
[IO.File]::WriteAllText((Join-Path $occupied 'owned.txt'), 'other installer')
`,
	);
	expect(await helperRun(where, 'install', { id: 'pwsh', helperScript: script })).toMatchObject({
		outcome: 'failed',
		route: 'fallback',
	});
	const parent = join(where.local, 'Programs', 'PowerShell');
	expect(await readdir(parent)).toEqual(['7.6.9']);
	expect(await readdir(join(parent, '7.6.9'))).toEqual(['owned.txt']);
	expect(await readFile(join(parent, '7.6.9', 'owned.txt'), 'utf8')).toBe('other installer');
	expect(await Bun.file(where.pathStore).exists()).toBe(false);
});

windows('an occupied PowerShell folder is named with a recovery action and preserved', async () => {
	const where = await use().fixture();
	const folder = join(where.local, 'Programs', 'PowerShell', '7.6.9');
	await mkdir(folder, { recursive: true });
	await writeFile(join(folder, 'owned.txt'), 'existing');
	const result = await helperRun(where, 'install', { id: 'pwsh' });
	expect(result).toMatchObject({ outcome: 'failed', route: 'fallback' });
	expect(result.detail).toContain('%LOCALAPPDATA%\\Programs\\PowerShell\\7.6.9');
	expect(result.detail).toContain('move it aside');
	expect(await readFile(join(folder, 'owned.txt'), 'utf8')).toBe('existing');
});
