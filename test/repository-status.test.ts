import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { repositoryStatus } from '../src/repository-status.ts';

const exec = promisify(execFile);

test('one status snapshot handles unborn, tracking, renames, missing upstream and detached HEAD', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-status-'));
	const git = async (...args: string[]) =>
		exec('git', ['-C', root, ...args], { windowsHide: true });
	try {
		await git('init', '-b', 'main');
		await git('config', 'user.name', 'Fixture');
		await git('config', 'user.email', 'fixture@example.invalid');
		expect(await repositoryStatus(root)).toEqual({
			branch: 'main',
			changed: 0,
			ahead: null,
			behind: null,
		});
		await writeFile(join(root, '# branch.head misleading'), 'original');
		await git('add', '.');
		await git('commit', '-m', 'baseline');
		await git('branch', 'upstream');
		await git('config', 'branch.main.remote', '.');
		await git('config', 'branch.main.merge', 'refs/heads/upstream');
		await git('mv', '# branch.head misleading', 'renamed file');
		await writeFile(join(root, '! misleading'), 'untracked');
		expect(await repositoryStatus(root)).toEqual({
			branch: 'main',
			changed: 2,
			ahead: 0,
			behind: 0,
		});
		await git('commit', '-m', 'rename');
		expect(await repositoryStatus(root)).toEqual({
			branch: 'main',
			changed: 1,
			ahead: 1,
			behind: 0,
		});
		await git('branch', '-D', 'upstream');
		expect(await repositoryStatus(root)).toEqual({
			branch: 'main',
			changed: 1,
			ahead: null,
			behind: null,
		});
		await git('checkout', '--detach');
		expect(await repositoryStatus(root)).toEqual({
			branch: 'detached',
			changed: 1,
			ahead: null,
			behind: null,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 15000);
