import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { summonStorageLayout, version } from '../package.json';
import { requireExecutable } from './executable.ts';
import { teamBuildOptions, teamDist, teamEntries } from './team-build-options.ts';

/** Kept beside the build that copies it, because window.ts resolves it relative to the output. */
const windowIcon = 'icons/summon.ico';

export async function buildTeam(): Promise<void> {
	// This fixed, generated output directory is the package glob; no prior build file may survive.
	await rm(teamDist, { recursive: true, force: true });
	await mkdir(teamDist, { recursive: true });
	for (const entry of teamEntries) {
		const result = await Bun.build(teamBuildOptions(entry));
		if (!result.success) throw new AggregateError(result.logs, 'Team window build failed.');
	}
	const renderer = await readFile(resolve(teamDist, 'renderer.js'), 'utf8');
	if (/^\/\/ node_modules\/(?:.*\/dev\/|debug\/|devlop\/lib\/development\.)/m.test(renderer))
		throw new Error('Team renderer contains development-only dependency modules.');
	// The stylesheets come from the page rather than a list beside it. A hand-kept copy list is
	// silent when it falls behind: the <link> 404s, the window renders the feature completely
	// unstyled, and every gate still passes because nothing here reads the page. board.css shipped
	// that way. xterm.css is linked too but is resolved from its package below, so it is expected
	// to be absent here; anything else missing is a typo and fails the build rather than the window.
	const desktopDir = resolve(import.meta.dir, 'desktop');
	const html = await readFile(resolve(desktopDir, 'index.html'), 'utf8');
	const stylesheets: string[] = [];
	for (const match of html.matchAll(/<link\b[^>]*\bhref="([^"]+\.css)"/g)) {
		const name = match[1];
		if (!name || name === 'xterm.css') continue;
		if (!(await Bun.file(resolve(desktopDir, name)).exists()))
			throw new Error(`index.html links ${name}, which does not exist in src/desktop.`);
		stylesheets.push(name);
	}
	for (const name of ['index.html', ...stylesheets])
		await copyFile(resolve(desktopDir, name), resolve(teamDist, name));
	// The window icon is named by window.ts rather than by the page, so it cannot be derived from
	// index.html the way the stylesheets above are. Check it explicitly instead: a missing icon
	// would otherwise leave Electron drawing its stock mark, which is a silent fallback of exactly
	// the kind the stylesheet check exists to prevent.
	if (!(await Bun.file(resolve(desktopDir, windowIcon)).exists()))
		throw new Error(`window.ts references ${windowIcon}, which does not exist in src/desktop.`);
	await mkdir(resolve(teamDist, 'icons'), { recursive: true });
	await copyFile(resolve(desktopDir, windowIcon), resolve(teamDist, windowIcon));
	const gitPath = requireExecutable('git');
	const git = Bun.spawnSync([gitPath, 'rev-parse', '--short', 'HEAD'], {
		cwd: resolve(import.meta.dir, '..'),
		windowsHide: true,
	});
	const revision = git.stdout.toString().trim();
	const hash = git.exitCode === 0 && /^[a-f0-9]+$/.test(revision) ? revision : 'unversioned';
	const status = Bun.spawnSync([gitPath, 'status', '--porcelain'], {
		cwd: resolve(import.meta.dir, '..'),
		windowsHide: true,
	});
	const dirty = status.exitCode === 0 && status.stdout.toString().trim() ? '+dirty' : '';
	const fingerprint = createHash('sha256');
	// Same list again, so the build id changes when a stylesheet does. Deriving it rather than
	// repeating it is the point: the fingerprint silently stopped covering board.css too.
	for (const name of [
		...teamEntries.map((entry) => entry[3]),
		'index.html',
		windowIcon,
		...stylesheets,
	]) {
		fingerprint.update(name);
		fingerprint.update(await readFile(resolve(teamDist, name)));
	}
	const buildId = fingerprint.digest('hex').slice(0, 10);
	const builtAt = new Date().toISOString();
	// The page shows this time in the viewer's zone (build-info.ts); the UTC text is what stays
	// on screen if the script never runs.
	const utc = builtAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
	const build = `v${version} ${hash}${dirty} · build ${buildId} · <time datetime="${builtAt}">${utc}</time>`;
	await writeFile(
		resolve(teamDist, 'build.json'),
		JSON.stringify({
			version,
			revision: `${hash}${dirty}`,
			buildId,
			builtAt,
			storageLayout: summonStorageLayout,
		}),
	);
	const index = resolve(teamDist, 'index.html');
	await writeFile(index, (await readFile(index, 'utf8')).replace('__SUMMON_BUILD__', build));
	await copyFile(
		Bun.resolveSync('@xterm/xterm/css/xterm.css', import.meta.dir),
		resolve(teamDist, 'xterm.css'),
	);
	const allowed = new Set([
		...teamEntries.map((entry) => entry[3]),
		'index.html',
		'build.json',
		'xterm.css',
		windowIcon,
		...stylesheets,
	]);
	for (const entry of await readdir(teamDist, { recursive: true, withFileTypes: true })) {
		if (entry.isDirectory()) continue;
		const name = resolve(entry.parentPath, entry.name)
			.slice(teamDist.length + 1)
			.replaceAll('\\', '/');
		if (!entry.isFile() || !allowed.has(name))
			throw new Error(`Unexpected Team window build output: ${name}`);
	}
}
