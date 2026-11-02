import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { maintenanceConfigSchema } from '../src/maintenance-host.ts';
import { plainMaintenancePath } from '../src/maintenance-offline.ts';
import { installMaintenanceCommand } from '../src/maintenance-setup.ts';
import { selectedTeamsBase } from '../src/storage-root.ts';

// One-time installation of the reviewed command, independent of the checkout it will roll back.
if (process.env.SUMMON_AGENT || process.env.SUMMON_NONCE)
	throw new Error('Install the standing updater from an ordinary operator terminal.');
if (process.argv.length !== 2) throw new Error('Usage: bun run setup:updater');
const repo = resolve(import.meta.dir, '..');
const home = selectedTeamsBase();
if (!home)
	throw new Error('Set SUMMON_TEAMS_HOME explicitly before installing a custom-store updater.');
const directory = join(home, 'maintenance');
await plainMaintenancePath(repo);
await plainMaintenancePath(directory);
const git = Bun.which('git');
if (!git) throw new Error('Git is required.');
for (const [args, expected] of [
	[['status', '--porcelain', '--untracked-files=all'], ''],
	[['branch', '--show-current'], 'main'],
] as const) {
	const check = Bun.spawnSync([git, '-C', repo, ...args], { windowsHide: true });
	if (check.exitCode !== 0 || check.stdout.toString().trim() !== expected)
		throw new Error('Install the reviewed updater from clean main.');
}
const link = join(
	process.env.BUN_INSTALL ?? join(homedir(), '.bun'),
	'install/global/node_modules/summon',
);
if (resolve(await realpath(link)) !== repo)
	throw new Error('Run setup from the installed linked Summon checkout.');
const config = maintenanceConfigSchema.parse({ version: 1, repo, home, link });
await installMaintenanceCommand(directory, JSON.stringify(config), async () => {
	const built = await Bun.build({
		entrypoints: [join(import.meta.dir, 'update-summon.ts')],
		target: 'bun',
		format: 'esm',
	});
	if (!built.success || built.outputs.length !== 1)
		throw new AggregateError(built.logs, 'Could not bundle the standing updater.');
	const output = built.outputs[0];
	if (!output) throw new Error('Missing updater bundle.');
	return output.text();
});
console.log(`Update: bun "${join(directory, 'update.js')}"`);
console.log(`Rollback: bun "${join(directory, 'update.js')}" --rollback`);
console.log('Command installed only. No checkout, dependencies, build, session or window changed.');
