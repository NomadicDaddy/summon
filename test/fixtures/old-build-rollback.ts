import { symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const rollbackPin = '3ab9b4c74e9d0333b9eb333afbe9713732112301';

/** Exercise the actual pinned tree, not a second implementation of its reader. */
export async function oldBuild(root: string) {
	const archive = Bun.spawn(['git', 'archive', '--format=tar', rollbackPin], {
		cwd: join(import.meta.dir, '../..'),
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	});
	const extract = Bun.spawn(['tar', '-xf', '-', '-C', root], {
		stdin: archive.stdout,
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	});
	const results = await Promise.all([
		archive.exited,
		extract.exited,
		new Response(archive.stderr).text(),
		new Response(extract.stderr).text(),
	]);
	if (results[0] !== 0 || results[1] !== 0)
		throw new Error(`Pinned rollback extraction failed: ${results[2]} ${results[3]}`);
	const dependencies = join(root, 'node_modules');
	await symlink(join(import.meta.dir, '../../node_modules'), dependencies, 'junction');
	return () => unlink(dependencies);
}
