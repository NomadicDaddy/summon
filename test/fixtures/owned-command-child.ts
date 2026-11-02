import { join } from 'node:path';

import { publishOwnedPids } from './owned-command-readiness.ts';

const [mode, root] = process.argv.slice(2);
if (!root) throw new Error('Missing disposable fixture directory.');
if (mode === 'normal') {
	console.log('normal output');
	console.error('normal diagnostic');
} else {
	const shell = Bun.spawn(
		process.platform === 'win32'
			? [
					'pwsh',
					'-NoProfile',
					'-NonInteractive',
					'-File',
					join(import.meta.dir, 'owned-command-hang.ps1'),
				]
			: ['sh', join(import.meta.dir, 'owned-command-hang.sh')],
		{
			env: { ...process.env, FIXTURE_READY: join(root, 'shell-ready') },
			stdout: 'inherit',
			stderr: 'inherit',
			windowsHide: true,
		},
	);
	await publishOwnedPids(root, { root: process.pid, shell: shell.pid });
	await shell.exited;
}
