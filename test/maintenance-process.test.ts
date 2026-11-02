import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	maintenanceProcessSnapshotCommand,
	verifyOfflineSnapshot,
} from '../src/maintenance-offline.ts';

test('real PowerShell snapshot detects windows, session runners and uncertainty with a positive control', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-maintenance-process-'));
	try {
		const command = join(root, 'command.ps1');
		await writeFile(command, maintenanceProcessSnapshotCommand);
		for (const scenario of ['quiet', 'session', 'window', 'unknown', 'missing-control']) {
			const child = Bun.spawn(
				[
					'pwsh',
					'-NoProfile',
					'-File',
					join(import.meta.dir, 'fixtures/maintenance-process-probe.ps1'),
					command,
					scenario,
				],
				{ stdout: 'pipe', stderr: 'pipe', windowsHide: true },
			);
			const [code, output] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			if (scenario === 'missing-control') {
				expect(code).not.toBe(0);
				continue;
			}
			expect(code).toBe(0);
			if (scenario === 'quiet') expect(() => verifyOfflineSnapshot(output)).not.toThrow();
			else expect(() => verifyOfflineSnapshot(output)).toThrow('not offline');
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 15000);
