import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { requireExecutable } from '../../src/executable.ts';

export async function releaseFixture(manifest: { summonStorageLayout?: number } = {}) {
	const root = await mkdtemp(join(tmpdir(), 'summon-release-version-'));
	const gitPath = requireExecutable('git');
	const run = (...args: string[]) =>
		Bun.spawnSync([gitPath, ...args], { cwd: root, windowsHide: true, timeout: 20_000 });
	const git = (...args: string[]): string => {
		const result = run(...args);
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	};
	const write = async (path: string, text: string): Promise<void> => {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), text);
	};
	const notes = (version: string): string =>
		`## [${version}] - 2026-10-20\n\n### Fixed\n\n- Changed the fixture's source behavior.\n`;
	const version = async (value: string): Promise<void> => {
		await write(
			'package.json',
			`${JSON.stringify({ ...manifest, name: 'fixture', version: value })}\n`,
		);
		await write('docs/CHANGELOG.md', notes(value));
	};
	const commit = (message = 'fixture change'): string => {
		git('add', '--all');
		git('commit', '--quiet', '-m', message);
		return git('rev-parse', 'HEAD');
	};
	git('init', '--quiet', '--initial-branch=main');
	git('config', 'user.name', 'Release fixture');
	git('config', 'user.email', 'fixture@example.invalid');
	git('config', 'commit.gpgsign', 'false');
	git('config', 'core.autocrlf', 'false');
	git('config', 'core.hooksPath', join(root, 'no-hooks'));
	await write('empty-ignore', '');
	git('config', 'core.excludesFile', join(root, 'empty-ignore'));
	await write('.gitignore', 'dist/\ninstalled/\nseal.json\n');
	await version('0.1.0');
	await write('src/app.ts', 'export const value=1;\n');
	const base = commit('version 0.1.0');
	git('switch', '--quiet', '-c', 'candidate');
	return {
		root,
		base,
		run,
		git,
		write,
		version,
		notes,
		commit,
		dispose: () => rm(root, { recursive: true, force: true }),
	};
}
