import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
	parseRepositoryFiles,
	repositoryCommits,
	repositoryGit,
	untrackedPreview,
} from '../src/repository-git.ts';
import { RepositoryService } from '../src/repository-service.ts';

const exec = promisify(execFile);
async function git(root: string, args: string[]): Promise<void> {
	await exec('git', ['-C', root, ...args], { windowsHide: true });
}
async function rejected(work: Promise<unknown>, text: string): Promise<void> {
	let error: string | undefined;
	await work.catch((value: unknown) => {
		error = String(value);
	});
	expect(error).toContain(text);
}

// This integration fixture launches Git repeatedly; the operator QC reached 5045 ms on Windows.
test('repository discovery includes root and children; read-only staged/worktree/history views preserve the index', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-repos-'));
	try {
		await git(root, ['init', '-b', 'main']);
		await git(root, ['config', 'user.name', 'Fixture']);
		await git(root, ['config', 'user.email', 'fixture@example.invalid']);
		await writeFile(join(root, 'tracked name.txt'), 'original\n');
		await git(root, ['add', '.']);
		await git(root, ['commit', '-m', 'Fixture baseline']);
		await git(root, ['branch', 'upstream']);
		await git(root, ['config', 'branch.main.remote', '.']);
		await git(root, ['config', 'branch.main.merge', 'refs/heads/upstream']);
		const child = join(root, 'child');
		await mkdir(child);
		await git(child, ['init', '-b', 'empty']);
		await writeFile(join(root, 'tracked name.txt'), 'staged\n');
		await git(root, ['add', '--', 'tracked name.txt']);
		await writeFile(join(root, 'tracked name.txt'), 'unstaged\n');
		await writeFile(join(root, 'new.txt'), '<img onerror=alert(1)> literal\n');
		const indexBefore = await readFile(join(root, '.git', 'index'));
		const service = new RepositoryService();
		const list = await service.list([{ slug: 'lead', name: 'Lead', cwd: root }]);
		expect(list.warnings).toHaveLength(0);
		expect(list.repositories).toHaveLength(2);
		const repo = list.repositories.find((item) => item.branch === 'main');
		if (!repo) throw new Error('Missing root repository.');
		expect(repo.members).toEqual([{ slug: 'lead', name: 'Lead' }]);
		expect(repo.changed).toBeGreaterThan(0);
		expect(repo.ahead).toBe(0);
		expect(repo.behind).toBe(0);
		expect(repo.fetchRecordedAt).toBeNull();
		const detail = await service.detail(repo.id);
		expect(
			detail.files.some(
				(file) =>
					file.path === 'tracked name.txt' &&
					file.staged === 'M' &&
					file.unstaged === 'M',
			),
		).toBe(true);
		expect(detail.commits[0]?.subject).toBe('Fixture baseline');
		expect(await service.diff(repo.id, { kind: 'staged', path: 'tracked name.txt' })).toContain(
			'+staged',
		);
		expect(
			await service.diff(repo.id, { kind: 'unstaged', path: 'tracked name.txt' }),
		).toContain('+unstaged');
		expect(await service.diff(repo.id, { kind: 'untracked', path: 'new.txt' })).toContain(
			'<img onerror',
		);
		const commit = detail.commits[0];
		if (!commit) throw new Error('No fixture commit.');
		expect(await service.diff(repo.id, { kind: 'commit', id: commit.id })).toContain(
			'+original',
		);
		await rejected(
			service.diff(repo.id, { kind: 'untracked', path: '../outside.txt' }),
			'no longer',
		);
		await rejected(service.detail('forged'), 'configured');
		await rejected(
			service.diff(repo.id, { kind: 'commit', id: 'a'.repeat(40) }),
			'displayed history',
		);
		expect(await readFile(join(root, '.git', 'index'))).toEqual(indexBefore);
		expect(await repositoryCommits(child)).toEqual([]);
		await git(root, ['branch', '-D', 'upstream']);
		const gone = (
			await service.list([{ slug: 'lead', name: 'Lead', cwd: root }])
		).repositories.find((item) => item.id === repo.id);
		expect(gone?.error).toBeUndefined();
		expect(gone?.ahead).toBeNull();
		expect(gone?.behind).toBeNull();
		expect(gone?.branch).toBe('main');
		expect(gone?.changed).toBeGreaterThan(0);
		await git(root, ['checkout', '--detach']);
		expect((await repositoryCommits(root))[0]?.id).toBe(commit.id);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);

test('status preserves rename/newline filenames and untracked previews reject traversal, links and oversized content', async () => {
	expect(parseRepositoryFiles('R  renamed file\0old file\0?? line\nname\0')).toEqual([
		{ path: 'renamed file', staged: 'R', unstaged: ' ' },
		{ path: 'line\nname', staged: '?', unstaged: '?' },
	]);
	const root = await mkdtemp(join(tmpdir(), 'summon-repo-preview-'));
	const outside = await mkdtemp(join(tmpdir(), 'summon-outside-'));
	try {
		await writeFile(join(root, '..note'), 'valid dot filename');
		expect(await untrackedPreview(root, '..note')).toBe('valid dot filename');
		await rejected(untrackedPreview(root, '../outside'), 'outside');
		await writeFile(join(root, 'binary'), Buffer.from([0, 1, 2]));
		expect(await untrackedPreview(root, 'binary')).toBe('Binary untracked file.');
		await writeFile(join(root, 'large'), Buffer.alloc(512 * 1024 + 1, 'x'));
		expect(await untrackedPreview(root, 'large')).toContain('preview limit');
		await writeFile(join(outside, 'private'), 'outside fixture');
		await symlink(
			outside,
			join(root, 'linked'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		await rejected(untrackedPreview(root, 'linked/private'), 'outside');
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

/*
 * A second working tree must not make a repository unreadable (#4504).
 *
 * The filter scan ahead of every status, diff, show and log reads git config at two scopes, and
 * `--worktree` is fatal wherever a repository has more than one working tree without
 * extensions.worktreeConfig. Agent worktrees make that ordinary, and the repos panel showed git's
 * advice about the config extension as the row's own error.
 */
test('a repository with a second working tree still reports status', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-repo-worktree-'));
	const extra = await mkdtemp(join(tmpdir(), 'summon-repo-linked-'));
	const linked = join(extra, 'tree');
	try {
		await git(root, ['init', '-b', 'main']);
		await git(root, ['config', 'user.name', 'Fixture']);
		await git(root, ['config', 'user.email', 'fixture@example.invalid']);
		await writeFile(join(root, 'tracked.txt'), 'original\n');
		await git(root, ['add', '.']);
		await git(root, ['commit', '-m', 'Fixture baseline']);
		await git(root, ['worktree', 'add', '-b', 'second', linked]);

		// The control: git itself must still refuse the scope, or this test proves nothing.
		await rejected(
			exec('git', ['-C', root, 'config', '--worktree', '--list'], { windowsHide: true }),
			'worktreeConfig',
		);

		await writeFile(join(root, 'tracked.txt'), 'changed\n');
		const files = parseRepositoryFiles(
			await repositoryGit(root, ['status', '--porcelain=v1', '-z']),
		);
		expect(files.map((file) => file.path)).toEqual(['tracked.txt']);
		expect((await repositoryGit(root, ['branch', '--show-current'])).trim()).toBe('main');
	} finally {
		await rm(root, { force: true, recursive: true });
		await rm(extra, { force: true, recursive: true });
	}
});
