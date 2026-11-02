import { expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { maintenanceHost } from '../src/maintenance-host.ts';

test('real Git host preserves main on rollback and refuses dirty or mismatched installation', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-maintenance-'));
	const repo = join(root, 'repo');
	const command = join(root, 'standing');
	const home = join(root, 'teams-base');
	await mkdir(repo);
	await mkdir(command);
	await mkdir(home);
	function git(...args: string[]): string {
		const child = Bun.spawnSync(['git', '-C', repo, ...args], { windowsHide: true });
		if (child.exitCode !== 0) throw new Error(child.stderr.toString());
		return child.stdout.toString().trim();
	}
	try {
		git('init', '-b', 'main');
		git('config', 'user.name', 'Maintenance fixture');
		git('config', 'user.email', 'fixture@example.invalid');
		git('config', 'commit.gpgsign', 'false');
		git('config', 'core.hooksPath', join(root, 'empty-hooks'));
		await writeFile(join(repo, '.gitignore'), 'dist/\nnode_modules/\n');
		await writeFile(join(repo, 'version.txt'), 'first');
		await writeFile(join(repo, 'package.json'), '{}');
		git('add', '.');
		git('commit', '-m', 'first fixture build');
		const old = git('rev-parse', 'HEAD');
		await writeFile(join(repo, 'version.txt'), 'second');
		await writeFile(join(repo, 'package.json'), JSON.stringify({ summonStorageLayout: 1 }));
		git('add', '.');
		git('commit', '-m', 'second fixture build');
		const main = git('rev-parse', 'HEAD');
		const link = join(root, 'installed');
		await symlink(repo, link, process.platform === 'win32' ? 'junction' : 'dir');
		await writeFile(
			join(command, 'config.json'),
			JSON.stringify({ version: 1, repo, home, link }),
		);
		await mkdir(join(repo, 'dist/team'), { recursive: true });
		await writeFile(
			join(repo, 'dist/team/build.json'),
			JSON.stringify({ revision: old.slice(0, 7), version: '1', buildId: 'a'.repeat(10) }),
		);
		const host = await maintenanceHost(command, join(command, 'logs'));
		await host.preflight();
		await host.compatible(old);
		await mkdir(join(home, 'mailboxes'));
		await rejects(host.compatible(main), /legacy default-team data/);
		expect(await host.readState()).toBeUndefined();
		await rmdir(join(home, 'mailboxes'));
		await mkdir(join(home, 'team-default'));
		await writeFile(
			join(home, '.team-layout.json'),
			JSON.stringify({ version: 1, defaultTeam: 'team-default', state: 'ready' }),
		);
		await rejects(host.compatible(old), /matching data and build/);
		await host.compatible(main);
		expect((await host.installed()).commit).toBe(old);
		await host.writeState({ version: 1, current: await host.installed() });
		expect((await host.readState())?.current.commit).toBe(old);
		await host.checkout(old, true);
		await host.assertCheckout(old, main, true);
		expect(git('rev-parse', 'main')).toBe(main);
		await host.checkout(main, false);
		await host.assertCheckout(main, main, false);
		await writeFile(join(repo, 'version.txt'), 'human edit');
		let refused = false;
		try {
			await host.preflight();
		} catch {
			refused = true;
		}
		expect(refused).toBe(true);
		expect(await Bun.file(join(repo, 'version.txt')).text()).toBe('human edit');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('bundled standing command runs outside source and refuses named-session execution', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-updater-bundle-'));
	try {
		const built = await Bun.build({
			entrypoints: [resolve(import.meta.dir, '../scripts/update-summon.ts')],
			target: 'bun',
			format: 'esm',
			outdir: root,
			naming: 'update.js',
		});
		expect(built.success).toBe(true);
		const help = Bun.spawn([process.execPath, join(root, 'update.js'), '--help'], {
			cwd: root,
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
		});
		expect(await help.exited).toBe(0);
		// The usage line names the bundle's real path; a short-form TEMP root spells it differently.
		expect(await new Response(help.stdout).text()).toContain(
			join(await realpath(root), 'update.js'),
		);
		const child = Bun.spawn([process.execPath, join(root, 'update.js'), '--rollback'], {
			cwd: root,
			env: { ...process.env, SUMMON_AGENT: 'fixture', SUMMON_NONCE: 'fixture' },
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
		});
		const [exit, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(exit).toBe(1);
		expect(output).toContain('ordinary operator terminal');
		expect(await Bun.file(join(root, 'state.json')).exists()).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
