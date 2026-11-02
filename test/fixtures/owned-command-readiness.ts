import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function publishOwnedPids(
	root: string,
	pids: { root: number; shell: number },
	write: (path: string, contents: string) => Promise<void> = writeFile,
): Promise<void> {
	// The reader polls pids.json; expose it only after the entire write has completed.
	const pending = join(root, 'pids.pending');
	await write(pending, JSON.stringify(pids));
	await rename(pending, join(root, 'pids.json'));
}
