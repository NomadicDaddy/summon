import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { teamBuildOptions, teamDist, teamEntries } from '../src/team-build-options.ts';
import { assertNoticesCurrent, thirdPartyNotices } from '../src/team-licenses.ts';

const mode = process.argv[2];
if (process.argv.length !== 3 || (mode !== '--write' && mode !== '--check'))
	throw new Error('Use --write to regenerate or --check for a read-only comparison.');
const root = resolve(import.meta.dir, '..');
const inputs = new Set<string>();
for (const entry of teamEntries) {
	const options = teamBuildOptions(entry);
	// Omitting outdir keeps build artifacts in memory; the check never rewrites dist.
	delete options.outdir;
	const result = await Bun.build({ ...options, metafile: true });
	if (!result.success || !result.metafile)
		throw new AggregateError(result.logs, 'Cannot inspect Team bundle licenses.');
	const output = result.outputs[0];
	if (!output || result.outputs.length !== 1)
		throw new Error(`Unexpected output count for ${entry[0]}`);
	const built = await readFile(resolve(teamDist, entry[3]));
	if (!built.equals(Buffer.from(await output.arrayBuffer())))
		throw new Error(`${entry[3]} is stale; run bun run build:team before checking licenses.`);
	for (const details of Object.values(result.metafile.outputs)) {
		for (const [path, info] of Object.entries(details.inputs)) {
			if (info.bytesInOutput > 0 && path.replaceAll('\\', '/').includes('node_modules/'))
				inputs.add(resolve(root, path));
		}
	}
}
const stylesheet = Bun.resolveSync('@xterm/xterm/css/xterm.css', import.meta.dir);
if (!(await readFile(resolve(teamDist, 'xterm.css'))).equals(await readFile(stylesheet)))
	throw new Error('Bundled xterm.css is stale.');
inputs.add(stylesheet);
const expected = await thirdPartyNotices([...inputs]);
const path = resolve(root, 'THIRD-PARTY-NOTICES.md');
if (mode === '--write') await writeFile(path, expected);
else assertNoticesCurrent(await readFile(path, 'utf8'), expected);
console.log(`Third-party notices ${mode === '--write' ? 'generated' : 'verified'}.`);
