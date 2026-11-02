import { createHash } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';

import type {
	RepositoryDetail,
	RepositoryDiff,
	RepositoryList,
	RepositoryMember,
	RepositorySummary,
} from './repository-model.ts';

import { missing } from './mail-files.ts';
import {
	repositoryCommits,
	repositoryFetchRecord,
	repositoryFiles,
	repositoryGit,
	untrackedPreview,
} from './repository-git.ts';
import { repositoryStatus } from './repository-status.ts';

async function exists(path: string): Promise<boolean> {
	return stat(path)
		.then(() => true)
		.catch((error: unknown) => {
			if (missing(error)) return false;
			throw error;
		});
}
async function enclosing(path: string): Promise<string | null> {
	let current = resolve(path);
	for (;;) {
		if (await exists(join(current, '.git'))) return realpath(current);
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
const diffSchema = z.union([
	z
		.object({ kind: z.enum(['staged', 'unstaged', 'untracked']), path: z.string().min(1) })
		.strict(),
	z.object({ kind: z.literal('commit'), id: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict(),
]);

export class RepositoryService {
	private readonly allowed = new Map<string, string>();

	async list(members: RepositoryMember[]): Promise<RepositoryList> {
		const memberRoots = new Map<string, string | null>();
		const paths = new Set<string>();
		const warnings: string[] = [];
		for (const cwd of new Set(members.map((member) => member.cwd))) {
			try {
				const root = await enclosing(cwd);
				memberRoots.set(cwd, root);
				if (root) paths.add(root);
				const children = await readdir(cwd, { withFileTypes: true });
				for (const child of children) {
					if (
						!child.isDirectory() ||
						child.name.startsWith('.') ||
						child.name === 'node_modules'
					)
						continue;
					const candidate = join(cwd, child.name);
					if (await exists(join(candidate, '.git'))) paths.add(await realpath(candidate));
				}
			} catch (error: unknown) {
				warnings.push(`${cwd}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const discovered = new Map<string, string>();
		const repositories: RepositorySummary[] = [];
		for (const path of [...paths].sort()) {
			const id = createHash('sha256')
				.update(process.platform === 'win32' ? path.toLowerCase() : path)
				.digest('hex');
			if (discovered.has(id)) continue;
			discovered.set(id, path);
		}
		const remaining = discovered.entries();
		await Promise.all(
			Array.from({ length: Math.min(4, discovered.size) }, async () => {
				for (const [id, path] of remaining)
					repositories.push(
						await this.summary(
							id,
							path,
							members.filter((member) => memberRoots.get(member.cwd) === path),
						),
					);
			}),
		);
		repositories.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
		this.allowed.clear();
		for (const [id, path] of discovered) this.allowed.set(id, path);
		return { repositories, warnings };
	}

	path(id: unknown): string {
		const path = typeof id === 'string' ? this.allowed.get(id) : undefined;
		if (!path) throw new Error('Repository is not in the configured working folders.');
		return path;
	}

	private async summary(
		id: string,
		path: string,
		members: RepositoryMember[],
	): Promise<RepositorySummary> {
		const base: RepositorySummary = {
			id,
			path,
			name: basename(path),
			branch: '',
			changed: 0,
			ahead: null,
			behind: null,
			checkedAt: new Date().toISOString(),
			fetchRecordedAt: null,
			members: members.map(({ slug, name }) => ({ slug, name })),
		};
		try {
			const [status, fetchRecordedAt] = await Promise.all([
				repositoryStatus(path),
				repositoryFetchRecord(path),
			]);
			Object.assign(base, status, { fetchRecordedAt });
		} catch (error: unknown) {
			base.error = error instanceof Error ? error.message : String(error);
		}
		return base;
	}

	async detail(id: unknown): Promise<RepositoryDetail> {
		const path = this.path(id);
		const [files, commits] = await Promise.all([
			repositoryFiles(path),
			repositoryCommits(path),
		]);
		return { files, commits, checkedAt: new Date().toISOString() };
	}

	async diff(id: unknown, input: unknown): Promise<string> {
		const path = this.path(id);
		const selection: RepositoryDiff = diffSchema.parse(input);
		const safe = ['--no-ext-diff', '--no-textconv', '--no-color'];
		if (selection.kind === 'commit') {
			if (!(await repositoryCommits(path)).some((commit) => commit.id === selection.id))
				throw new Error('Commit is no longer in the displayed history.');
			return repositoryGit(path, [
				'show',
				'--no-show-signature',
				...safe,
				selection.id,
				'--',
			]);
		}
		const file = (await repositoryFiles(path)).find((item) => item.path === selection.path);
		if (
			!file ||
			(selection.kind === 'staged' && [' ', '?'].includes(file.staged)) ||
			(selection.kind === 'unstaged' && [' ', '?'].includes(file.unstaged)) ||
			(selection.kind === 'untracked' && file.staged !== '?')
		)
			throw new Error('File is no longer in this changes group; refresh.');
		if (selection.kind === 'untracked') return untrackedPreview(path, selection.path);
		return repositoryGit(path, [
			'diff',
			...safe,
			...(selection.kind === 'staged' ? ['--cached'] : []),
			'--',
			selection.path,
		]);
	}
}
