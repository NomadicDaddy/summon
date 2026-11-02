import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { validatePrerequisiteSources } from '../src/prerequisite-sources.ts';

const manifest = resolve(import.meta.dir, '../installer/prerequisite-sources.json');

// The two known entries are typed as present, so corruptions need no non-null assertions.
type Manifest = {
	bun: Record<string, unknown>;
	pwsh: Record<string, unknown>;
	[id: string]: Record<string, unknown>;
};

async function pinned(): Promise<Manifest> {
	return JSON.parse(await readFile(manifest, 'utf8')) as Manifest;
}

test('the reviewed fallback manifest names official, hash-pinned Windows x64 releases', async () => {
	const sources = validatePrerequisiteSources(await pinned());
	expect(sources.bun.fallback.version).toBe('1.4.3');
	expect(sources.pwsh.fallback.version).toBe('7.6.9');
	expect(sources.bun.wingetScope).toBe('user');
	expect(sources.pwsh.wingetScope).toBe('machine');
	expect(sources.pwsh.wingetInstallerType).toBe('wix');
});

const corruptions: [string, (sources: Manifest) => void, RegExp][] = [
	[
		'a missing PowerShell MSI selection',
		(sources) => {
			delete sources.pwsh.wingetInstallerType;
		},
		/installer type/,
	],
	[
		'a PowerShell MSIX selection',
		(sources) => {
			sources.pwsh.wingetInstallerType = 'msix';
		},
		/installer type/,
	],
	[
		'an installer type on Bun',
		(sources) => {
			sources.bun.wingetInstallerType = 'wix';
		},
		/installer type/,
	],
	[
		'a non-official host',
		(sources) => {
			(sources.bun.fallback as Record<string, unknown>).url =
				'https://example.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-windows-x64.zip';
		},
		/official/,
	],
	[
		'another architecture',
		(sources) => {
			(sources.bun.fallback as Record<string, unknown>).url =
				'https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-windows-x64-baseline.zip';
		},
		/Windows x64/,
	],
	[
		'a version below the minimum',
		(sources) => {
			const fallback = sources.pwsh.fallback as Record<string, unknown>;
			fallback.version = '7.5.13';
			fallback.url =
				'https://github.com/PowerShell/PowerShell/releases/download/v7.5.13/PowerShell-7.5.13-win-x64.zip';
		},
		/minimum/,
	],
	[
		'a URL for a different version than pinned',
		(sources) => {
			(sources.pwsh.fallback as Record<string, unknown>).url =
				'https://github.com/PowerShell/PowerShell/releases/download/v7.6.8/PowerShell-7.6.8-win-x64.zip';
		},
		/official 7\.6\.9/,
	],
	[
		'dot segments that normalize out of the release path',
		(sources) => {
			(sources.bun.fallback as Record<string, unknown>).url =
				'https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/../../../../other/repo/releases/download/x/bun-windows-x64.zip';
		},
		/official/,
	],
	[
		'a query string on the official asset',
		(sources) => {
			(sources.bun.fallback as Record<string, unknown>).url =
				'https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-windows-x64.zip?x=1';
		},
		/official/,
	],
	[
		'a version that is not x.y.z',
		(sources) => {
			(sources.bun.fallback as Record<string, unknown>).version = '1.4.3-canary';
		},
		/x\.y\.z/,
	],
	[
		'an unpinned hash',
		(sources) => {
			(sources.bun.fallback as Record<string, unknown>).sha256 = 'latest';
		},
		/SHA256/,
	],
	[
		'another winget package',
		(sources) => {
			sources.pwsh.winget = 'Microsoft.PowerShell.Preview';
		},
		/winget package/,
	],
	[
		'an executable outside the archive',
		(sources) => {
			(sources.bun.fallback as Record<string, unknown>).executable = '../bun.exe';
		},
		/relative \.exe/,
	],
	[
		'an extra prerequisite',
		(sources) => {
			sources.node = {};
		},
		/exactly bun and pwsh/,
	],
];

for (const [label, corrupt, message] of corruptions)
	test(`the manifest check refuses ${label}`, async () => {
		const sources = await pinned();
		corrupt(sources);
		expect(() => validatePrerequisiteSources(sources)).toThrow(message);
	});
