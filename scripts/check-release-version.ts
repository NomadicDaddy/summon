import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { releaseGit } from '../src/release-version-git.ts';
import { checkReleaseVersion, checkWorkingReleaseVersion } from '../src/release-version.ts';

const root = process.cwd();
const args = process.argv.slice(2);
async function absent(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return false;
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
			return true;
		throw error;
	}
}

async function isLooseMainPruning(current: string): Promise<boolean> {
	if (releaseGit(root, ['rev-parse', '--show-ref-format']).trim() !== 'files') return false;
	const packed = resolve(
		root,
		releaseGit(root, ['rev-parse', '--git-path', 'packed-refs']).trim(),
	);
	// Git's files backend unlocks packed-refs before pruning loose copies. A real
	// deletion keeps this lock through prepared, including its nested packed update.
	// https://github.com/git/git/blob/v2.55.0/refs/files-backend.c
	if (!(await absent(`${packed}.lock`)) || (await absent(packed))) return false;
	const info = await lstat(packed);
	if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) return false;
	const contents = await readFile(packed, 'utf8');
	return (
		contents.split('\n').includes(`${current} refs/heads/main`) &&
		(await absent(`${packed}.lock`))
	);
}

if (args[0] === '--reference-transaction' && args.length === 1) {
	for (const line of (await Bun.stdin.text()).trim().split('\n')) {
		const parts = line.split(' ');
		if (parts[2] !== 'refs/heads/main') continue;
		const [old, candidate] = parts;
		if (!old || !candidate || !/^[a-f0-9]{40}$/.test(old) || !/^[a-f0-9]{40}$/.test(candidate))
			throw new Error('Malformed main reference transaction.');
		const published = releaseGit(root, [
			'for-each-ref',
			'--format=%(refname) %(objectname) %(symref)',
			'refs/heads/main',
		])
			.split('\n')
			.filter((entry) => entry.startsWith('refs/heads/main '));
		const current = published.length === 1 ? published[0]?.split(' ')[1] : undefined;
		if (
			!current ||
			!/^[a-f0-9]{40}$/.test(current) ||
			published[0] !== `refs/heads/main ${current} `
		)
			throw new Error('Main creation has no verifiable release baseline.');
		if (!/^0+$/.test(old) && old !== current)
			throw new Error('Published main differs from the transaction baseline.');
		if (/^0+$/.test(candidate)) {
			if (!(await isLooseMainPruning(current)))
				throw new Error('Main deletion has no verifiable release baseline.');
		} else if (candidate !== current) {
			console.log(JSON.stringify(await checkReleaseVersion(root, current, candidate)));
		}
	}
} else if (args.length === 2 && args[0] && args[1]) {
	console.log(JSON.stringify(await checkReleaseVersion(root, args[0], args[1])));
} else if (!args.length) {
	console.log(JSON.stringify(await checkWorkingReleaseVersion(root)));
} else {
	throw new Error('Usage: check-release-version [<base-hash> <candidate-hash>]');
}
