import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { executableCommand, requireExecutable } from '../src/executable.ts';
const root = await realpath(resolve(import.meta.dir, '..'));
const git = Bun.spawnSync([requireExecutable('git'), 'rev-parse', '--show-toplevel'], {
	cwd: root,
	stdout: 'pipe',
	stderr: 'pipe',
	windowsHide: true,
});
if (git.exitCode !== 0) throw new Error('Hook setup requires a Git checkout of summon.');
const top = await realpath(git.stdout.toString().trim());
const normalize = (path: string): string =>
	process.platform === 'win32' ? path.toLowerCase() : path;
if (normalize(top) !== normalize(root))
	throw new Error('Refusing to change hooks in a parent repository.');
for (const command of [
	['git', 'config', '--local', 'core.hooksPath', '.githooks'],
	[process.execPath, resolve(root, 'scripts/run-bash.ts'), '.githooks/leak-guard-setup.sh'],
]) {
	const child = Bun.spawn(executableCommand(command), {
		cwd: root,
		stdin: 'ignore',
		stdout: 'inherit',
		stderr: 'inherit',
		windowsHide: true,
	});
	if ((await child.exited) !== 0) throw new Error('Contributor hook setup failed.');
}
