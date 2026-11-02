import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { locked } from '../src/mail-files.ts';
import { installMaintenanceCommand } from '../src/maintenance-setup.ts';

test('concurrent setup publishes one matching pair and refuses the competing installer', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-setup-race-'));
	const entered = Promise.withResolvers<boolean>();
	const release = Promise.withResolvers<boolean>();
	try {
		const first = installMaintenanceCommand(root, 'first config', async () => {
			entered.resolve(true);
			await release.promise;
			return 'first bundle';
		});
		await entered.promise;
		const second = installMaintenanceCommand(root, 'second config', () =>
			Promise.resolve('second bundle'),
		);
		const settled = Promise.allSettled([first, second]);
		release.resolve(true);
		expect((await settled).map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
		expect(await readFile(join(root, 'config.json'), 'utf8')).toBe('first config');
		expect(await readFile(join(root, 'update.js'), 'utf8')).toBe('first bundle');
	} finally {
		release.resolve(true);
		await rm(root, { recursive: true, force: true });
	}
});

test('setup waits for the same lock held by active maintenance', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-setup-lock-'));
	const entered = Promise.withResolvers<boolean>();
	const release = Promise.withResolvers<boolean>();
	let maintenanceActive = false;
	try {
		const maintenance = locked(join(root, 'update.lock'), async () => {
			maintenanceActive = true;
			entered.resolve(true);
			await release.promise;
			maintenanceActive = false;
		});
		await entered.promise;
		const setup = installMaintenanceCommand(root, 'config', () => {
			expect(maintenanceActive).toBe(false);
			return Promise.resolve('bundle');
		});
		release.resolve(true);
		await Promise.all([maintenance, setup]);
		expect(await readFile(join(root, 'update.js'), 'utf8')).toBe('bundle');
	} finally {
		release.resolve(true);
		await rm(root, { recursive: true, force: true });
	}
});

test('partial publication or retained state is preserved and cannot be overwritten by setup', async () => {
	for (const name of ['update.js', 'config.json', 'state.json']) {
		const root = await mkdtemp(join(tmpdir(), 'summon-setup-partial-'));
		try {
			await writeFile(join(root, name), 'retained evidence');
			const outcome = await Promise.allSettled([
				installMaintenanceCommand(root, 'new config', () => Promise.resolve('new bundle')),
			]);
			expect(outcome[0].status).toBe('rejected');
			expect(await readFile(join(root, name), 'utf8')).toBe('retained evidence');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
});
