import { resolve } from 'node:path';

import { checkReleaseCandidateVersion } from '../src/release-candidate.ts';
import { releaseGit } from '../src/release-version-git.ts';

const root = resolve(import.meta.dir, '..');
const head = releaseGit(root, ['rev-parse', '--verify', 'HEAD']).trim();
const main = releaseGit(root, ['rev-parse', '--verify', 'refs/heads/main']).trim();

function assertCandidate(): void {
	const current = releaseGit(root, ['rev-parse', '--verify', 'HEAD']).trim();
	if (current !== head) throw new Error('Release candidate commit changed during checks.');
	if (releaseGit(root, ['rev-parse', '--verify', 'refs/heads/main']).trim() !== main)
		throw new Error('Release baseline main changed during checks.');
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
console.log(JSON.stringify(await checkReleaseCandidateVersion(root, main, head)));
assertCandidate();
await run(['run', 'smoke:qc']);
assertCandidate();
await run(['pm', 'pack', '--dry-run']);
assertCandidate();
