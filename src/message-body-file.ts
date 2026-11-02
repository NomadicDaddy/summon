import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { missing } from './mail-files.ts';
import { currentAgent } from './mail-identity.ts';
import { storageRoot } from './store.ts';

const normalize = (path: string): string =>
	process.platform === 'win32' ? path.toLowerCase() : path;

/** Recognized roots only: no registry scan and no peer private file is opened. */
export async function assertPublicOrOwn(path: string): Promise<void> {
	const ownRoot = await realpath(storageRoot());
	const sources = new Set([
		ownRoot,
		...(normalize(basename(ownRoot)).startsWith('team-') ? [dirname(ownRoot)] : []),
		resolve(process.env.SUMMON_TEAMS_HOME ?? ownRoot),
		join(homedir(), '.summon'),
	]);
	const roots = await Promise.all(
		[...sources].map(async (source) =>
			realpath(source).catch((error: unknown) => {
				if (missing(error)) return undefined;
				throw error;
			}),
		),
	);
	const agent = currentAgent();
	for (const root of roots) {
		if (!root) continue;
		const suffix = relative(root, path);
		if (isAbsolute(suffix)) continue;
		const parts = suffix.split(sep);
		if (parts[0] === '..') continue;
		let nested = 0;
		while (normalize(parts[nested] ?? '').startsWith('team-')) nested += 1;
		const teamRoot = resolve(root, ...parts.slice(0, nested));
		const section = normalize(parts[nested] ?? '');
		const owner = normalize(parts[nested + 1] ?? '');
		if (!['mailboxes', 'runtime', 'scratch'].includes(section) || !owner) continue;
		if (section === 'scratch' && owner === 'shared') continue;
		if (normalize(teamRoot) === normalize(ownRoot) && owner === agent) continue;
		throw new Error('File bodies cannot read another teammate or team’s private storage.');
	}
}

/** Resolve file input in the caller process; never ask a privileged writer to read it. */
export async function messageBodyArgs(args: string[], start: number): Promise<string[]> {
	if (args[start] !== '--body-file') {
		if (args.slice(start + 1).includes('--body-file'))
			throw new Error('Use either one inline body or --body-file <path>, not both.');
		return args;
	}
	const file = args[start + 1];
	if (!file || args.length !== start + 2)
		throw new Error('--body-file requires exactly one path and replaces the inline body.');
	const path = await realpath(resolve(file));
	if (process.env.SUMMON_AGENT) await assertPublicOrOwn(path);
	const bytes = await readFile(path);
	let body: string;
	try {
		body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new Error('--body-file must contain valid UTF-8.');
	}
	if (!body.trim() || body.includes('\0'))
		throw new Error('--body-file must contain nonempty text without NUL characters.');
	return [...args.slice(0, start), body];
}
