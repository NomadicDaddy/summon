import { releaseGit } from './release-version-git.ts';
import { checkReleaseVersion, versionBaseline } from './release-version.ts';

/** Compare an integrated main candidate with the commit before its latest version advance. */
export function checkReleaseCandidateVersion(root: string, main: string, candidate: string) {
	if (main !== candidate) return checkReleaseVersion(root, main, candidate);
	const stamp = versionBaseline(root, candidate);
	const parent = releaseGit(root, ['rev-list', '--parents', '-n', '1', stamp])
		.trim()
		.split(' ')[1];
	// The repository's first version has no earlier version to compare with.
	return checkReleaseVersion(root, parent ?? candidate, candidate);
}
