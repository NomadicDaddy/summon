import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { releaseCommit, releaseGit } from '../src/release-version-git.ts';
import {
	checkInstalledRelease,
	checkReleaseVersion,
	sourceVersion,
} from '../src/release-version.ts';

export async function prepareTeamSeal(
	root: string,
	installedDirectory: string,
	outputPath: string,
): Promise<{
	sealed: boolean;
	output: string;
	candidate: string;
	version: string;
	files: number;
	adopted: boolean;
	restarted: boolean;
}> {
	root = resolve(root);
	const builtPath = join(root, 'dist/team');
	const installedPath = resolve(installedDirectory);
	if ((await lstat(builtPath)).isSymbolicLink() || (await lstat(installedPath)).isSymbolicLink())
		throw new Error('Bundle directory links cannot be sealed.');
	const builtRoot = await realpath(builtPath);
	const installedRoot = await realpath(installedPath);
	const comparable = (path: string): string =>
		process.platform === 'win32' ? path.toLowerCase() : path;
	if (comparable(builtRoot) === comparable(installedRoot))
		throw new Error('Candidate and installed bundles must be distinct physical directories.');
	const requestedOutput = resolve(outputPath);
	const output = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
	for (const bundle of [builtRoot, installedRoot]) {
		const destination = relative(bundle, output);
		if (
			!destination ||
			(destination !== '..' &&
				!destination.startsWith(`..${sep}`) &&
				!isAbsolute(destination))
		)
			throw new Error('The seal must be outside both bundles.');
	}
	const candidate = releaseCommit(root, releaseGit(root, ['rev-parse', 'HEAD']).trim());
	const main = releaseCommit(root, releaseGit(root, ['rev-parse', 'refs/heads/main']).trim());
	function clean(): void {
		if (releaseGit(root, ['status', '--porcelain=v1', '--untracked-files=all']).trim())
			throw new Error('A seal requires a clean source checkout.');
		if (
			releaseGit(root, ['rev-parse', 'HEAD']).trim() !== candidate ||
			releaseGit(root, ['rev-parse', 'refs/heads/main']).trim() !== main
		)
			throw new Error('Source pins moved during seal preparation.');
	}
	clean();
	const source = await checkReleaseVersion(root, main, candidate);
	for (const bundle of [builtRoot, installedRoot]) {
		if ((await lstat(join(bundle, 'build.json'))).isSymbolicLink())
			throw new Error('Build identity links cannot be sealed.');
	}
	const installedText = await readFile(join(installedRoot, 'build.json'), 'utf8');
	const installed = await checkInstalledRelease(root, candidate, installedText);
	const builtText = await readFile(join(builtRoot, 'build.json'), 'utf8');
	const built: unknown = JSON.parse(builtText);
	if (
		!built ||
		typeof built !== 'object' ||
		!('revision' in built) ||
		typeof built.revision !== 'string' ||
		releaseCommit(root, built.revision) !== candidate ||
		sourceVersion(builtText) !== source.version
	)
		throw new Error('Built identity does not match the clean candidate.');
	const files: { path: string; bytes: number; sha256: string }[] = [];
	async function inventory(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink() || (await lstat(path)).isSymbolicLink())
				throw new Error('Bundle links cannot be sealed.');
			if (entry.isDirectory()) await inventory(path);
			else if (entry.isFile()) {
				const bytes = await readFile(path);
				files.push({
					path: relative(builtRoot, path).replaceAll('\\', '/'),
					bytes: bytes.length,
					sha256: createHash('sha256').update(bytes).digest('hex'),
				});
			} else throw new Error('Unexpected bundle entry.');
		}
	}
	await inventory(builtRoot);
	files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	const first = JSON.stringify(files);
	files.length = 0;
	await inventory(builtRoot);
	files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	if (JSON.stringify(files) !== first)
		throw new Error('Built files changed during seal preparation.');
	if (
		(await readFile(join(builtRoot, 'build.json'), 'utf8')) !== builtText ||
		(await readFile(join(installedRoot, 'build.json'), 'utf8')) !== installedText
	)
		throw new Error('Build identities changed during seal preparation.');
	clean();
	const seal = {
		candidate,
		tree: releaseGit(root, ['rev-parse', 'HEAD^{tree}']).trim(),
		version: source.version,
		build: built,
		source,
		installed,
		files,
		independentBuildVerified: false,
		adoptionAuthorized: false,
	};
	await writeFile(output, `${JSON.stringify(seal, null, 2)}\n`, { flag: 'wx' });
	return {
		sealed: true,
		output,
		candidate,
		version: source.version,
		files: files.length,
		adopted: false,
		restarted: false,
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (
		args.length !== 4 ||
		args[0] !== '--installed' ||
		!args[1] ||
		args[2] !== '--out' ||
		!args[3]
	)
		throw new Error(
			'Usage: prepare-team-seal --installed <bundle-directory> --out <new-manifest-path>',
		);
	console.log(
		JSON.stringify(await prepareTeamSeal(resolve(import.meta.dir, '..'), args[1], args[3])),
	);
}
