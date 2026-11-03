import { resolve } from 'node:path';

import { releaseGit } from '../src/release-version-git.ts';
import { checkWorkingReleaseVersion } from '../src/release-version.ts';

const root = resolve(import.meta.dir, '..');
const head = releaseGit(root, ['rev-parse', '--verify', 'HEAD']).trim();

function assertCandidate(): void {
	const current = releaseGit(root, ['rev-parse', '--verify', 'HEAD']).trim();
	if (current !== head) throw new Error('Release candidate commit changed during checks.');
	if (releaseGit(root, ['status', '--porcelain=v1', '--untracked-files=all']).trim())
		throw new Error('Release candidate requires a clean working tree.');
}

async function run(args: string[]): Promise<void> {
	const child = Bun.spawn([process.execPath, ...args], {
		cwd: root,
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit',
		windowsHide: true,
	});
	if ((await child.exited) !== 0) throw new Error(`Release check failed: bun ${args.join(' ')}`);
}

assertCandidate();
console.log(JSON.stringify(await checkWorkingReleaseVersion(root)));
assertCandidate();
await run(['run', 'smoke:qc']);
assertCandidate();
await run(['pm', 'pack', '--dry-run']);
assertCandidate();
