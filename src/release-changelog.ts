import { releaseBlob, releaseGit } from './release-version-git.ts';

/** Read the path actually stored in a historical Git tree, never a working-file fallback. */
export function historicalReleaseNotes(root: string, commit: string): string {
	const present = releaseGit(root, [
		'ls-tree',
		'--name-only',
		'-z',
		commit,
		'--',
		'docs/CHANGELOG.md',
		'CHANGELOG.md',
	])
		.split('\0')
		.filter(Boolean);
	if (present.length !== 1)
		throw new Error('Historical revision must contain exactly one public changelog.');
	const path = present[0];
	if (!path) throw new Error('Missing historical public changelog.');
	return releaseBlob(root, commit, path);
}

export async function candidateReleaseNotes(
	get: (path: string) => Promise<string | null>,
	historicalRebuild: boolean,
): Promise<string> {
	const [canonical, former] = await Promise.all([get('docs/CHANGELOG.md'), get('CHANGELOG.md')]);
	if (canonical !== null && former !== null)
		throw new Error('Candidate must have one public changelog at docs/CHANGELOG.md.');
	if (canonical !== null) return canonical;
	// This is called only after the clean historical-main ancestry check, never for a new tip.
	if (historicalRebuild && former !== null) return former;
	throw new Error('Missing candidate docs/CHANGELOG.md.');
}
