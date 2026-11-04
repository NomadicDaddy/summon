import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { candidateReleaseNotes, historicalReleaseNotes } from './release-changelog.ts';
import {
	changedReleasePaths,
	releaseBlob,
	releaseCommit,
	releaseGit,
	releaseText,
} from './release-version-git.ts';

export interface ReleaseVersionResult {
	base: string;
	candidate: string;
	baseline: string;
	previousVersion: string;
	version: string;
	reason: string;
	paths: string[];
}

export function sourceVersion(text: string): string {
	const manifest: unknown = JSON.parse(text);
	const value =
		manifest && typeof manifest === 'object' && 'version' in manifest
			? manifest.version
			: undefined;
	const number = '(?:0|[1-9]\\d*)';
	const identifier = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
	const semantic = new RegExp(
		`^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
	);
	if (typeof value !== 'string' || !semantic.test(value))
		throw new Error('A valid semantic package version is required.');
	return value;
}

function section(text: string, version: string): string {
	const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = new RegExp(`^## \\[${escaped}\\] - (\\d{4}-\\d{2}-\\d{2})[ \\t]*\\r?$`, 'm').exec(
		text,
	);
	if (!match || !match[1]) throw new Error(`Missing dated CHANGELOG section for ${version}.`);
	const date = new Date(`${match[1]}T00:00:00Z`);
	if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1])
		throw new Error('Invalid changelog date.');
	const rest = text.slice(match.index + match[0].length);
	const next = rest.search(/^## /m);
	const body = next < 0 ? rest : rest.slice(0, next);
	if (
		!/^### (?:Added|Changed|Deprecated|Removed|Fixed|Security)\r?\n(?:(?!^### ).)*?^- \S/ms.test(
			body,
		)
	)
		throw new Error(`CHANGELOG ${version} needs categorized release notes.`);
	return match[0] + body;
}

export function versionBaseline(root: string, base: string): string {
	for (const commit of releaseGit(root, [
		'log',
		'--first-parent',
		'--format=%H',
		base,
		'--',
		'package.json',
	])
		.trim()
		.split('\n')) {
		const current = sourceVersion(releaseBlob(root, commit, 'package.json'));
		const parent = releaseGit(root, ['rev-list', '--parents', '-n', '1', commit])
			.trim()
			.split(' ')[1];
		if (
			!parent ||
			Bun.semver.order(current, sourceVersion(releaseBlob(root, parent, 'package.json'))) !==
				0
		) {
			// Notes may be repaired by a later documentation-only commit at the same version.
			section(
				historicalReleaseNotes(root, base),
				sourceVersion(releaseBlob(root, base, 'package.json')),
			);
			return commit;
		}
	}
	throw new Error('No version-bearing main baseline could be established.');
}

function documentationOrTest(path: string): boolean {
	return (
		path.startsWith('test/') ||
		path.startsWith('docs/') ||
		['PRIVACY.md', 'SECURITY.md', 'SUPPORT.md'].includes(path) ||
		/^(?:README|CHANGELOG|CONTRIBUTING|LICENSE|THIRD-PARTY-NOTICES)(?:\.[^/]*)?$/.test(path)
	);
}

async function formattingOnly(path: string, before: string, after: string): Promise<boolean> {
	if (before === after) return true;
	// Only the installed formatter is used. Never load a candidate's plugins or configuration.
	try {
		const { format } = await import('prettier');
		const options = { filepath: path, endOfLine: 'lf' as const };
		return (await format(before, options)) === (await format(after, options));
	} catch {
		// Unknown formats and unavailable formatter dependencies cannot prove an exemption.
		return false;
	}
}

async function impact(
	paths: string[],
	before: (path: string) => Promise<string | null>,
	after: (path: string) => Promise<string | null>,
	sameMode: (path: string) => Promise<boolean>,
): Promise<string> {
	const shipped = paths.filter((path) => !documentationOrTest(path));
	if (!shipped.length) return 'test/documentation-only';
	for (const path of shipped) {
		if (!(await sameMode(path))) return 'runtime, bundled guidance or guard behavior';
		const old = await before(path);
		const current = await after(path);
		if (old === null || current === null || !(await formattingOnly(path, old, current)))
			return 'runtime, bundled guidance or guard behavior';
	}
	return 'formatter-equivalent changes only';
}

async function releaseMode(
	root: string,
	commit: string,
	path: string,
	working: boolean,
): Promise<string> {
	if (!working)
		return releaseGit(root, ['ls-tree', '-z', commit, '--', path]).split(' ')[0] ?? '';
	try {
		const stat = await lstat(resolve(root, path));
		if (stat.isSymbolicLink()) return '120000';
		if (!stat.isFile()) return '';
		const staged =
			releaseGit(root, ['ls-files', '--stage', '-z', '--', path]).split(' ')[0] ?? '';
		const committed =
			releaseGit(root, ['ls-tree', '-z', commit, '--', path]).split(' ')[0] ?? '';
		if (staged !== committed) return staged;
		if (process.platform !== 'win32') return stat.mode & 0o111 ? '100755' : '100644';
		return staged;
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
			return '';
		throw error;
	}
}

function optionalBlob(root: string, commit: string, path: string): Promise<string | null> {
	const exists = releaseGit(root, ['ls-tree', '-z', commit, '--', path]);
	return Promise.resolve(exists ? releaseBlob(root, commit, path) : null);
}

async function verify(
	root: string,
	base: string,
	candidate: string,
	working: boolean,
	historicalRebuild = false,
): Promise<ReleaseVersionResult> {
	if (releaseGit(root, ['rev-parse', '--is-shallow-repository']).trim() === 'true')
		throw new Error('Complete source history is required for the release baseline.');
	base = releaseCommit(root, base);
	candidate = releaseCommit(root, candidate);
	releaseGit(root, ['merge-base', '--is-ancestor', base, candidate]);
	const baseline = versionBaseline(root, base);
	const previousVersion = sourceVersion(releaseBlob(root, base, 'package.json'));
	const get = async (path: string): Promise<string | null> => {
		if (!working) return optionalBlob(root, candidate, path);
		try {
			return releaseText(await readFile(resolve(root, path)));
		} catch (error) {
			if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
				return null;
			throw error;
		}
	};
	const manifest = await get('package.json');
	if (manifest === null) throw new Error('Missing candidate package.json.');
	const version = sourceVersion(manifest);
	const changelog = await candidateReleaseNotes(get, historicalRebuild);
	const paths = new Set(changedReleasePaths(root, baseline, candidate));
	if (working) {
		for (const path of releaseGit(root, [
			'diff',
			'--no-ext-diff',
			'--no-textconv',
			'--no-renames',
			'--name-only',
			'-z',
			candidate,
			'--',
		])
			.split('\0')
			.filter(Boolean))
			paths.add(path);
		for (const path of releaseGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])
			.split('\0')
			.filter(Boolean))
			paths.add(path);
	}
	// Operator #29235: suspend numeric ordering for the public 1.0.0 normalization.
	let reason = 'version changed with dated release notes';
	if (Bun.semver.order(version, previousVersion) !== 0) {
		const release = section(changelog, version);
		const prior = historicalReleaseNotes(root, base);
		if (prior.includes(release))
			throw new Error('Release notes were not updated for this integration.');
		// A version change earlier in the range cannot cover behavior added after it.
		// Recheck the candidate unless a different working version covers dirty changes.
		if (
			Bun.semver.order(
				version,
				sourceVersion(releaseBlob(root, candidate, 'package.json')),
			) === 0
		)
			await verify(root, candidate, candidate, working);
	} else {
		reason = await impact(
			[...paths],
			(path) => optionalBlob(root, baseline, path),
			get,
			async (path) => {
				const before = await releaseMode(root, baseline, path, false);
				return (
					(before === '100644' || before === '100755') &&
					before === (await releaseMode(root, candidate, path, working))
				);
			},
		);
		if (reason === 'runtime, bundled guidance or guard behavior')
			throw new Error(
				'Shipped behavior changed without a version bump and dated CHANGELOG section.',
			);
	}
	return { base, candidate, baseline, previousVersion, version, reason, paths: [...paths] };
}

export function checkReleaseVersion(
	root: string,
	base: string,
	candidate: string,
): Promise<ReleaseVersionResult> {
	return verify(root, base, candidate, false);
}

export async function checkWorkingReleaseVersion(root: string): Promise<ReleaseVersionResult> {
	const base = releaseGit(root, ['rev-parse', '--verify', 'refs/heads/main']).trim();
	const head = releaseGit(root, ['rev-parse', '--verify', 'HEAD']).trim();
	// The offline updater rebuilds a previous installed release detached, without rewinding main.
	// This is a rebuild of published history, never an exemption for a proposed ref update.
	if (base !== head && releaseGit(root, ['merge-base', base, head]).trim() === head) {
		const status = () =>
			releaseGit(root, ['status', '--porcelain=v1', '--untracked-files=all']).trim();
		if (status()) throw new Error('A historical main rebuild requires a clean working tree.');
		// Recheck its own version-bearing baseline: an unversioned historical runtime tip
		// does not qualify merely because it is reachable from today's main.
		const result = await verify(root, head, head, false, true);
		if (
			status() ||
			releaseGit(root, ['rev-parse', '--verify', 'HEAD']).trim() !== head ||
			releaseGit(root, ['rev-parse', '--verify', 'refs/heads/main']).trim() !== base
		)
			throw new Error('Historical rebuild source changed during preflight.');
		return { ...result, base, reason: `clean historical main rebuild; ${result.reason}` };
	}
	return verify(root, base, head, true);
}

export async function checkInstalledRelease(
	root: string,
	candidate: string,
	installedBuildText: string,
): Promise<ReleaseVersionResult> {
	const installed: unknown = JSON.parse(installedBuildText);
	if (
		!installed ||
		typeof installed !== 'object' ||
		!('revision' in installed) ||
		typeof installed.revision !== 'string'
	)
		throw new Error('Installed build revision is required.');
	const base = releaseCommit(root, installed.revision);
	const installedVersion = sourceVersion(installedBuildText);
	if (sourceVersion(releaseBlob(root, base, 'package.json')) !== installedVersion)
		throw new Error('Installed build version disagrees with its source revision.');
	return verify(root, base, candidate, false);
}
