import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { RepositoryService } from '../src/repository-service.ts';

const exec = promisify(execFile);

test.each(['local', 'include', 'worktree'] as const)(
	'Repos disables %s filters and signature programs with positive controls',
	async (scope) => {
		const root = await mkdtemp(join(tmpdir(), 'summon-repo-programs-'));
		const git = async (...args: string[]) =>
			(await exec('git', ['-C', root, ...args], { windowsHide: true })).stdout;
		const marker = (name: string) => Bun.file(join(root, '.git', name)).exists();
		try {
			await git('init', '-b', 'main');
			await git('config', 'user.name', 'Fixture');
			await git('config', 'user.email', 'fixture@example.invalid');
			await writeFile(join(root, 'file.txt'), 'initial\n');
			await git('add', '.');
			await git('commit', '-m', 'Fixture baseline');
			await writeFile(join(root, '.gitattributes'), '*.txt filter=probe\n');
			await git('config', 'filter.probe.clean', 'echo ran > .git/filter-fired; cat');
			if (scope !== 'local') {
				await git('config', '--unset', 'filter.probe.clean');
				if (scope === 'include') {
					await writeFile(
						join(root, '.git', 'filter-config'),
						'[filter "probe"]\nclean = "echo ran > .git/filter-fired; cat"\nrequired = true\n',
					);
					await git('config', 'include.path', './filter-config');
				} else {
					await git('config', 'extensions.worktreeConfig', 'true');
					await git(
						'config',
						'--worktree',
						'filter.probe.clean',
						'echo ran > .git/filter-fired; cat',
					);
					await git('config', '--worktree', 'filter.probe.required', 'true');
				}
			}
			await writeFile(join(root, 'file.txt'), 'changed\n');
			await git('status', '--porcelain');
			expect(await marker('filter-fired')).toBe(true);
			await git('add', 'file.txt');
			await writeFile(join(root, 'file.txt'), 'working\n');
			await rm(join(root, '.git', 'filter-fired'));
			await writeFile(
				join(root, '.git', 'probe-gpg'),
				'#!/bin/sh\necho ran > .git/gpg-fired\nexit 1\n',
			);
			await chmod(join(root, '.git', 'probe-gpg'), 0o755);
			await git('config', 'gpg.program', './.git/probe-gpg');
			await git('config', 'log.showSignature', 'true');
			const original = await git('cat-file', 'commit', 'HEAD');
			const signed = original.replace(
				'\n\n',
				'\ngpgsig -----BEGIN PGP SIGNATURE-----\n fixture\n -----END PGP SIGNATURE-----\n\n',
			);
			const hash = Bun.spawn(
				['git', '-C', root, 'hash-object', '-t', 'commit', '-w', '--stdin'],
				{
					stdin: new Blob([signed]),
					stdout: 'pipe',
					stderr: 'pipe',
					windowsHide: true,
				},
			);
			const id = (await new Response(hash.stdout).text()).trim();
			expect(await hash.exited).toBe(0);
			await git('update-ref', 'refs/heads/main', id);
			await git('log', '-1');
			expect(await marker('gpg-fired')).toBe(true);
			await rm(join(root, '.git', 'gpg-fired'));
			const index = await readFile(join(root, '.git', 'index'));
			const service = new RepositoryService();
			const repo = (await service.list([{ slug: 'fixture', name: 'Fixture', cwd: root }]))
				.repositories[0];
			if (!repo) throw new Error('Fixture repository missing.');
			expect(repo.error).toBeUndefined();
			const detail = await service.detail(repo.id);
			expect(detail.commits[0]?.id).toBe(id);
			expect(await service.diff(repo.id, { kind: 'staged', path: 'file.txt' })).toContain(
				'+changed',
			);
			expect(await service.diff(repo.id, { kind: 'unstaged', path: 'file.txt' })).toContain(
				'+working',
			);
			expect(await service.diff(repo.id, { kind: 'commit', id })).toContain('+initial');
			expect(await marker('filter-fired')).toBe(false);
			expect(await marker('gpg-fired')).toBe(false);
			expect(await readFile(join(root, '.git', 'index'))).toEqual(index);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
	// Real Git setup and positive controls need a local budget; product Git retains its 20s limit.
	30000,
);
