import { writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

if (process.env.SUMMON_TEST_OFFLINE !== '1')
	throw new Error('Isolated migration fixture required.');
const realSpawn = Bun.spawn;
let inventories = 0;
function spawnInventory(options: {
	cmd: string[];
	stdout?: 'pipe';
	stderr?: 'pipe';
	windowsHide?: boolean;
	signal?: AbortSignal;
}): ReturnType<typeof Bun.spawn> {
	if (options.cmd[4]?.startsWith('$p = Get-CimInstance Win32_Process -Filter')) {
		if (process.env.SUMMON_TEST_CIM_CONTROL !== undefined) {
			return realSpawn({
				...options,
				cmd: [
					'pwsh',
					'-NoProfile',
					'-NonInteractive',
					'-File',
					join(import.meta.dir, 'checkpoint-cim-control.ps1'),
					options.cmd[4],
				],
			});
		}
		if (process.env.SUMMON_TEST_PROCESS_START === undefined) return realSpawn(options);
		return realSpawn({
			...options,
			cmd: [process.execPath, join(import.meta.dir, 'checkpoint-inventory-result.ts')],
			env: {
				...process.env,
				SUMMON_TEST_INVENTORY: process.env.SUMMON_TEST_PROCESS_START,
				SUMMON_TEST_INVENTORY_EXIT: process.env.SUMMON_TEST_PROCESS_START_EXIT ?? '0',
			},
		});
	}
	if (
		options.cmd[0] !== 'pwsh' ||
		options.cmd[3] !== '-Command' ||
		!options.cmd[4]?.startsWith('Get-CimInstance Win32_Process')
	)
		throw new Error('Unexpected subprocess in offline fixture.');
	inventories += 1;
	if (inventories === 2 && process.env.SUMMON_TEST_CHANGE_DEFERRED === '1') {
		const root = process.env.SUMMON_HOME ?? '';
		if (
			basename(root) !== 'agents with spaces' ||
			!basename(dirname(root)).startsWith('summon-workflow-')
		)
			throw new Error('Disposable metadata mutation requires the mail harness root.');
		writeFileSync(join(root, 'runtime/beta/checkpoint.json'), '{"changed-by-fixture":true}');
	}
	return realSpawn({
		...options,
		cmd: [process.execPath, join(import.meta.dir, 'checkpoint-inventory-result.ts')],
	});
}
Bun.spawn = spawnInventory as typeof Bun.spawn;
