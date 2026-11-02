import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { packageManager, version } from '../package.json';
import { requireExecutable } from '../src/executable.ts';
import { validatePrerequisiteSources } from '../src/prerequisite-sources.ts';
import { runtimePrerequisites } from '../src/runtime-prerequisites.ts';
import { run } from './installer-command.ts';
import { installerLauncher } from './installer-launcher.ts';

if (process.platform !== 'win32' || process.arch !== 'x64')
	throw new Error('Build the Windows x64 installer on Windows x64.');
if (`bun@${Bun.version}` !== packageManager)
	throw new Error(`Build with exactly ${packageManager}, matching bun.lock.`);
const root = resolve(import.meta.dir, '..');
// The reviewed pinned manifest only; the build never looks up versions or hashes itself.
const prerequisiteSources = validatePrerequisiteSources(
	JSON.parse(await readFile(join(root, 'installer/prerequisite-sources.json'), 'utf8')),
);
const minimum = (id: 'bun' | 'pwsh'): string => {
	const value = runtimePrerequisites.find((item) => item.id === id)?.minimumVersion ?? '';
	if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`Invalid ${id} minimum version.`);
	return value;
};
const compiler = process.env.SUMMON_ISCC;
if (!compiler || !(await Bun.file(compiler).exists()))
	throw new Error('Set SUMMON_ISCC to the Inno Setup 7.1.1 ISCC.exe path.');
const compilerInfo = Bun.spawnSync([compiler, '--version'], { windowsHide: true });
const compilerStdout = compilerInfo.stdout.toString();
const compilerStderr = compilerInfo.stderr.toString();
console.log(
	JSON.stringify({
		stage: 'compiler-version',
		exitCode: compilerInfo.exitCode,
		success: compilerInfo.success,
		signalCode: compilerInfo.signalCode ?? null,
		stdout: compilerStdout,
		stderr: compilerStderr,
	}),
);
if (!compilerInfo.success || compilerInfo.exitCode !== 0 || compilerInfo.signalCode)
	throw new Error('Inno Setup compiler version process did not complete successfully.');
if (!/^7\.1\.1(?:\s|$)/.test(`${compilerStdout}\n${compilerStderr}`.trim()))
	throw new Error('Use the pinned Inno Setup 7.1.1 compiler.');
const gitPath = requireExecutable('git');
const revisionResult = Bun.spawnSync([gitPath, 'rev-parse', '--short=12', 'HEAD'], { cwd: root });
const revision = revisionResult.stdout.toString().trim();
if (revisionResult.exitCode !== 0 || !/^[a-f0-9]{12}$/.test(revision))
	throw new Error('Cannot identify installer source revision.');
const status = Bun.spawnSync([gitPath, 'status', '--porcelain'], { cwd: root });
if (status.exitCode !== 0) throw new Error('Cannot inspect source state.');
const dirty = status.stdout.toString().trim().length > 0;
const build = `${version}-${revision}${dirty ? '-dirty' : ''}`;
// Unique output avoids deleting another build or reusing stale staging files.
const output = join(root, 'dist', 'installer', `${build}-${Date.now()}`);
const payload = join(output, 'payload');
const application = join(payload, 'app');
await mkdir(application, { recursive: true });
await run([process.execPath, 'run', 'build:team'], root);
await run([process.execPath, 'run', 'check:licenses'], root);
// Explicit runtime inputs: never copy the checkout, registry, .env, or a developer profile.
for (const name of [
	'src',
	'scripts',
	'skills',
	'gallery',
	'templates',
	'docs',
	'dist/team',
	'package.json',
	'bun.lock',
	'LICENSE',
	'README.md',
	'PRIVACY.md',
	'THIRD-PARTY-NOTICES.md',
])
	await cp(join(root, name), join(application, name), { recursive: true });
await run(
	[process.execPath, 'install', '--production', '--frozen-lockfile', '--ignore-scripts'],
	application,
);
// Ship application libraries, including Electron's runtime and licenses. Bun and pwsh are external.
await cp(
	join(root, 'node_modules/electron/dist'),
	join(application, 'node_modules/electron/dist'),
	{ recursive: true },
);
await cp(
	join(root, 'node_modules/electron/path.txt'),
	join(application, 'node_modules/electron/path.txt'),
);
await writeFile(join(output, 'summon.cmd'), installerLauncher(build));
const files: { path: string; sha256: string; bytes: number }[] = [];
for (const entry of await readdir(payload, { recursive: true, withFileTypes: true })) {
	if (!entry.isFile()) continue;
	const path = join(entry.parentPath, entry.name);
	const contents = await readFile(path);
	files.push({
		path: path.slice(payload.length + 1).replaceAll('\\', '/'),
		sha256: createHash('sha256').update(contents).digest('hex'),
		bytes: contents.length,
	});
}
files.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(
	join(payload, 'installer-build.json'),
	JSON.stringify(
		{
			version,
			revision,
			dirty,
			buildBun: Bun.version,
			prerequisites: runtimePrerequisites,
			prerequisiteSources,
			innoSetup: '7.1.1',
			lockSha256: createHash('sha256')
				.update(await readFile(join(root, 'bun.lock')))
				.digest('hex'),
			files,
		},
		null,
		2,
	),
);
await run([process.execPath, 'run', 'check:installer', payload], root);
await run(
	[
		compiler,
		`/DBuildId=${build}`,
		`/DAppVersion=${version}`,
		`/DBunMinimum=${minimum('bun')}`,
		`/DPwshMinimum=${minimum('pwsh')}`,
		// The licence links on the Dependencies page name the pinned release tags.
		`/DBunFallbackVersion=${prerequisiteSources.bun.fallback.version}`,
		`/DPwshFallbackVersion=${prerequisiteSources.pwsh.fallback.version}`,
		`/DPayload=${payload}`,
		`/DLauncher=${join(output, 'summon.cmd')}`,
		`/O${output}`,
		join(root, 'installer/summon.iss'),
	],
	root,
);
const artifact = join(output, `summon-${build}-windows-x64.exe`);
const sha256 = createHash('sha256')
	.update(await readFile(artifact))
	.digest('hex');
await writeFile(`${artifact}.sha256`, `${sha256}  ${artifact.split(/[\\/]/).at(-1)}\n`);
console.log(JSON.stringify({ artifact, sha256, revision, dirty }));
