import { requireExecutable } from './executable.ts';

export function releaseText(bytes: Uint8Array): string {
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new Error('Non-UTF-8 source cannot qualify as formatter-equivalent.');
	}
}

export function releaseGit(root: string, args: readonly string[]): string {
	// Read-only comparisons must tolerate normal CRLF conversion, while every other
	// diagnostic (including inaccessible ignore/config files) remains an error.
	const result = Bun.spawnSync(
		[requireExecutable('git'), '-c', 'core.safecrlf=false', '--no-pager', ...args],
		{
			cwd: root,
			windowsHide: true,
			timeout: 20_000,
			maxBuffer: 16 * 1024 * 1024,
		},
	);
	const error = result.stderr.toString().trim();
	if (result.exitCode !== 0 || error)
		throw new Error(`Version preflight could not inspect Git (${result.exitCode}): ${error}`);
	return releaseText(result.stdout);
}

export function releaseCommit(root: string, value: string): string {
	if (!/^[a-f0-9]{7,40}$/.test(value)) throw new Error('Expected an exact commit hash.');
	const commit = releaseGit(root, ['rev-parse', '--verify', `${value}^{commit}`]).trim();
	if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid resolved commit.');
	return commit;
}

export function releaseBlob(root: string, commit: string, path: string): string {
	if (path.includes('\0') || path.includes('\n')) throw new Error('Invalid source path.');
	return releaseGit(root, ['show', `${commit}:${path}`]);
}

export function changedReleasePaths(root: string, base: string, candidate: string): string[] {
	return releaseGit(root, [
		'diff',
		'--no-ext-diff',
		'--no-textconv',
		'--no-renames',
		'--name-only',
		'-z',
		base,
		candidate,
		'--',
	])
		.split('\0')
		.filter(Boolean);
}
