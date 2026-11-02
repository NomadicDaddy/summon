import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { missing } from './mail-files.ts';
import { prepareStorageLayout } from './storage-layout.ts';
import { storageRoot } from './store.ts';

/** Keep the installed teammate instructions aligned with the bundled template. */
export async function initializeStore(): Promise<void> {
	await prepareStorageLayout();
	const root = storageRoot();
	const source = await readFile(resolve(import.meta.dir, '../templates/AGENTS.md.template'));
	const target = join(root, 'AGENTS.md');
	let existing: Buffer | undefined;
	try {
		existing = await readFile(target);
	} catch (error: unknown) {
		if (!missing(error)) throw error;
	}
	if (existing?.equals(source)) return;
	await mkdir(root, { recursive: true, mode: 0o700 });
	await writeFile(target, source, { mode: 0o600 });
}
