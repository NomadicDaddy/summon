import { execFile } from 'node:child_process';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import type { RepositoryCommit, RepositoryFile } from './repository-model.ts';

import { requireExecutable } from './executable.ts';
import { missing } from './mail-files.ts';

const exec = promisify(execFile);

async function runGit(path: string, args: string[], overrides: string[] = []): Promise<string> {
	const result = await exec(
		requireExecutable('git'),
		[
			'--no-pager',
			'--no-optional-locks',
			'--literal-pathspecs',
			'-c',
			'core.fsmonitor=false',
			'-c',
			'core.quotePath=false',
			'-c',
			'log.showSignature=false',
			...overrides,
			'-C',
			path,
			...args,
		],
		{
			env: Object.fromEntries(
				Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
			),
			windowsHide: true,
			timeout: 20000,
			maxBuffer: 2 * 1024 * 1024,
		},
	);
	return result.stdout;
}

/** No pager, fsmonitor, repository-defined filters or signature programs; callers disable diff drivers. */
export async function repositoryGit(path: string, args: string[]): Promise<string> {
	const overrides: string[] = [];
	if (['status', 'diff', 'show', 'log'].includes(args[0] ?? '')) {
		const filters = new Set<string>();
		const scopes = await Promise.all(
			['--local', '--worktree'].map(async (scope) => {
				/*
				 * A scope that cannot be READ contributes no filters, which is the same answer as a
				 * scope that holds none - so skip it rather than failing the command it was preparing.
				 *
				 * --worktree is fatal in any repository with more than one working tree unless
				 * extensions.worktreeConfig is set. Agent worktrees make that the ordinary state of a
				 * busy repository, and because this scan runs ahead of every status, diff, show and
				 * log, one extra working tree made the whole repository unreadable: the repos panel
				 * showed git's advice about the config extension as the row's error (#4504).
				 */
				try {
					return await runGit(path, [
						'config',
						scope,
						'--includes',
						'--null',
						'--name-only',
						'--list',
					]);
				} catch {
					return '';
				}
			}),
		);
		for (const names of scopes) {
			for (const key of names.split('\0')) {
				const match = /^(filter\..+)\.(clean|smudge|process)$/i.exec(key);
				if (match?.[1]) filters.add(match[1]);
			}
		}
		for (const filter of filters) {
			for (const action of ['clean', 'smudge', 'process'])
				overrides.push('-c', `${filter}.${action}=`);
			overrides.push('-c', `${filter}.required=false`);
		}
	}
	return runGit(path, args, overrides);
}

export function parseRepositoryFiles(raw: string): RepositoryFile[] {
	const records = raw.split('\0');
	const files: RepositoryFile[] = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record || record.length < 4) continue;
		const staged = record[0] ?? ' ';
		const unstaged = record[1] ?? ' ';
		files.push({ path: record.slice(3), staged, unstaged });
		if (staged === 'R' || staged === 'C' || unstaged === 'R' || unstaged === 'C') index++;
	}
	return files;
}

export async function repositoryFiles(path: string): Promise<RepositoryFile[]> {
	return parseRepositoryFiles(
		await repositoryGit(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
	);
}

export async function repositoryFetchRecord(path: string): Promise<string | null> {
	const location = (await repositoryGit(path, ['rev-parse', '--git-path', 'FETCH_HEAD'])).trim();
	const info = await stat(resolve(path, location)).catch((error: unknown) => {
		if (missing(error)) return null;
		throw error;
	});
	return info?.mtime.toISOString() ?? null;
}

export async function repositoryCommits(path: string): Promise<RepositoryCommit[]> {
	const state = await repositoryGit(path, [
		'status',
		'--porcelain=v2',
		'--branch',
		'--untracked-files=no',
	]);
	if (state.split('\n').includes('# branch.oid (initial)')) return [];
	const raw = await repositoryGit(path, [
		'log',
		'--no-show-signature',
		'-20',
		'--format=%H%x00%h%x00%aI%x00%s',
	]);
	return raw
		.trimEnd()
		.split('\n')
		.map((line) => {
			const [id, short, at, subject] = line.split('\0');
			if (!id || !short || !at || subject === undefined)
				throw new Error('Invalid Git history.');
			return { id, short, at, subject };
		});
}

/** Untracked previews are bounded, literal text, and may only target a current status entry. */
export async function untrackedPreview(root: string, path: string): Promise<string> {
	const target = resolve(root, path);
	const inside = relative(root, target);
	if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
		throw new Error('File is outside the repository.');
	if ((await lstat(target)).isSymbolicLink())
		throw new Error('Symlink previews are not supported.');
	const canonical = await realpath(target);
	const canonicalInside = relative(await realpath(root), canonical);
	if (
		canonicalInside === '..' ||
		canonicalInside.startsWith(`..${sep}`) ||
		isAbsolute(canonicalInside)
	)
		throw new Error('File resolves outside the repository.');
	const file = await open(canonical, 'r');
	try {
		const info = await file.stat();
		if (!info.isFile()) return 'This untracked entry is not a regular file.';
		if (info.size > 512 * 1024)
			return 'This untracked file is larger than the 512 KiB preview limit.';
		const data = await file.readFile();
		if (data.includes(0)) return 'Binary untracked file.';
		return data.toString('utf8');
	} finally {
		await file.close();
	}
}
