import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { optionalText } from './mail-files.ts';

/** Electron's package directory owns dist/version on Windows, Linux and macOS. */
export async function assertElectronRuntime(packageDirectory: string): Promise<void> {
	const manifest: unknown = JSON.parse(
		await readFile(join(packageDirectory, 'package.json'), 'utf8'),
	);
	if (
		!manifest ||
		typeof manifest !== 'object' ||
		!('version' in manifest) ||
		typeof manifest.version !== 'string' ||
		!manifest.version.trim()
	)
		throw new Error('Electron package version is unavailable. Reinstall its pinned package.');
	const declared = manifest.version.trim().replace(/^v/, '');
	const installed = (await optionalText(join(packageDirectory, 'dist', 'version')))
		?.trim()
		.replace(/^v/, '');
	if (installed !== declared)
		throw new Error(
			`Electron runtime ${installed || 'missing'} does not match package ${declared}. Close all Summon Team Windows and run bun scripts/install-electron.ts before reopening.`,
		);
}
