import { checkReleaseCandidateVersion } from '../src/release-candidate.ts';
import { releaseGit } from '../src/release-version-git.ts';
import { checkReleaseVersion, checkWorkingReleaseVersion } from '../src/release-version.ts';

const root = process.cwd();
const args = process.argv.slice(2);

if (args.length === 1 && args[0] === '--release') {
	const head = releaseGit(root, ['rev-parse', '--verify', 'HEAD']).trim();
	const main = releaseGit(root, ['rev-parse', '--verify', 'refs/heads/main']).trim();
	const clean = () =>
		!releaseGit(root, ['status', '--porcelain=v1', '--untracked-files=all']).trim();
	if (!clean()) throw new Error('Release candidate requires a clean working tree.');
	const result = await checkReleaseCandidateVersion(root, main, head);
	if (
		!clean() ||
		releaseGit(root, ['rev-parse', '--verify', 'HEAD']).trim() !== head ||
		releaseGit(root, ['rev-parse', '--verify', 'refs/heads/main']).trim() !== main
	)
		throw new Error('Release candidate source changed during preflight.');
	console.log(JSON.stringify(result));
} else if (args.length === 2 && args[0] && args[1]) {
	console.log(JSON.stringify(await checkReleaseVersion(root, args[0], args[1])));
} else if (!args.length) {
	console.log(JSON.stringify(await checkWorkingReleaseVersion(root)));
} else {
	throw new Error('Usage: check-release-version [--release | <base-hash> <candidate-hash>]');
}
