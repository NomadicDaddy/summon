import { createHash } from 'node:crypto';
import { symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const rollbackPin = '3ab9b4c74e9d0333b9eb333afbe9713732112301';
const archiveName = 'old-build-3ab9b4c-fixture.tar';
const archiveHash = 'e6364c067e6df3836ee66168ce14943ff92b11eda9cb4d9dd0a1890a5a416707';

/** Exercise the actual pinned old source, retained as a narrow tar without Git history. */
export async function oldBuild(root: string) {
	const archive = join(import.meta.dir, archiveName);
	const actualHash = createHash('sha256')
		.update(new Uint8Array(await Bun.file(archive).arrayBuffer()))
		.digest('hex');
	if (actualHash !== archiveHash)
		throw new Error(`Pinned rollback archive changed: ${rollbackPin}`);
	const extract = Bun.spawn(['tar', '-xf', '-', '-C', root], {
		stdin: Bun.file(archive),
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	});
	const results = await Promise.all([extract.exited, new Response(extract.stderr).text()]);
	if (results[0] !== 0) throw new Error(`Pinned rollback extraction failed: ${results[1]}`);
	const dependencies = join(root, 'node_modules');
	await symlink(join(import.meta.dir, '../../node_modules'), dependencies, 'junction');
	return () => unlink(dependencies);
}
