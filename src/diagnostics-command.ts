import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

import { collectDiagnostics } from './diagnostics-collect.ts';
import { currentAgent } from './mail-identity.ts';
import { assertPublicOrOwn } from './message-body-file.ts';
import { slugFor, storageRoot } from './store.ts';
import { teamDist } from './team-build-options.ts';

const usage = 'Usage: summon --diagnostics [--member name] [--since ISO-time] [--out path]';
async function bundledBuild() {
	const path = join(teamDist, 'build.json');
	const stat = await lstat(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096)
		throw new Error('Bundled Team Window build identity is unavailable.');
	const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
	return {
		...(value && typeof value === 'object' ? value : {}),
		kind: 'bundle beside this CLI source; running Window identity is not established',
	};
}

async function ensureDirectory(path: string): Promise<void> {
	try {
		await mkdir(path);
	} catch (error: unknown) {
		if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
			throw error;
	}
	const stat = await lstat(path);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error('Diagnostics output directory is redirected or has an unexpected type.');
}

async function outputPath(member: string, requested?: string): Promise<string> {
	if (requested) {
		const path = resolve(requested);
		const parent = await realpath(dirname(path));
		await assertPublicOrOwn(parent);
		const stat = await lstat(parent);
		if (!stat.isDirectory()) throw new Error('Diagnostics output parent must be a directory.');
		return path;
	}
	const root = storageRoot();
	await ensureDirectory(root);
	const scratch = join(root, 'scratch');
	await ensureDirectory(scratch);
	const own = join(scratch, member);
	await ensureDirectory(own);
	return join(own, `summon-diagnostics-${new Date().toISOString().replaceAll(':', '-')}.json`);
}

export async function diagnosticsCommand(args: string[]): Promise<void> {
	const caller = currentAgent();
	const used = new Set<string>();
	let member = caller;
	let since: string | undefined;
	let out: string | undefined;
	if (args.length % 2 !== 0) throw new Error(usage);
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key || !value || used.has(key)) throw new Error(usage);
		used.add(key);
		if (key === '--member') member = slugFor(value);
		else if (key === '--since')
			since = new Date(z.iso.datetime({ offset: true }).parse(value)).toISOString();
		else if (key === '--out') out = value;
		else throw new Error(usage);
	}
	if (member !== caller)
		throw new Error('Diagnostics may include only the current named session.');
	const now = new Date();
	const start = since ?? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
	if (Date.parse(start) > now.getTime()) throw new Error('--since must not be in the future.');
	const bundle = await collectDiagnostics(member, start, bundledBuild, {}, now.toISOString());
	const path = await outputPath(member, out);
	await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
	console.log(path.replaceAll(homedir(), '~').replaceAll(homedir().replaceAll('\\', '/'), '~'));
}
