import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { locked } from '../src/mail-files.ts';
import { maintenanceHost } from '../src/maintenance-host.ts';
import { plainMaintenancePath } from '../src/maintenance-offline.ts';
import { maintainInstallation } from '../src/maintenance-update.ts';

try {
	if (process.argv.length === 3 && process.argv[2] === '--help') {
		console.log(`Usage: bun "${join(import.meta.dir, 'update.js')}" [--rollback]`);
		process.exit(0);
	}
	if (process.argv.slice(2).some((arg) => arg !== '--rollback') || process.argv.length > 3)
		throw new Error('Usage: bun update.js [--rollback]');
	if (process.env.SUMMON_AGENT || process.env.SUMMON_NONCE)
		throw new Error(
			'Run from an ordinary operator terminal. Never clear session identity to bypass this guard.',
		);
	const directory = import.meta.dir;
	await plainMaintenancePath(directory);
	const logs = join(
		directory,
		'logs',
		`${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
	);
	await mkdir(logs, { recursive: true });
	console.log(`Maintenance logs: ${logs}`);
	await locked(join(directory, 'update.lock'), async () => {
		const host = await maintenanceHost(directory, logs);
		const state = await maintainInstallation(host, process.argv.includes('--rollback'));
		await Bun.write(join(logs, 'result.json'), JSON.stringify(state));
		console.log(JSON.stringify({ completed: true, ...state, restarted: false, logs }));
	});
} catch (error: unknown) {
	console.error(error instanceof Error ? error.message : String(error));
	console.error(
		'Update refused or failed. Retain logs and state; remain offline after a partial update. No session was stopped or started.',
	);
	process.exitCode = 1;
}
