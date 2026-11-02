import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { withRetentionPaths } from '../src/mail-retention-access.ts';
import { retentionInventory } from '../src/mail-retention-inventory.ts';

let root: string;
const windowsTest = test.skipIf(process.platform !== 'win32');
async function refuses(action: Promise<unknown>, message?: string) {
	const error: unknown = await action.then(
		() => null,
		(failure: unknown) => failure,
	);
	expect(error).toBeInstanceOf(Error);
	if (message && error instanceof Error) expect(error.message).toContain(message);
}
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'summon-retention-access-'));
});
afterEach(async () => {
	if (
		dirname(resolve(root)) !== resolve(tmpdir()) ||
		!basename(root).startsWith('summon-retention-access-')
	)
		throw new Error('Unexpected disposable guard fixture.');
	await rm(root, { recursive: true, force: true });
});

windowsTest(
	'held pin leaf, ancestor and mailbox section cannot be replaced before access',
	async () => {
		const own = join(root, 'own');
		const section = join(own, 'inbox');
		const pins = join(own, 'pins.json');
		const foreign = join(root, 'foreign');
		await mkdir(section, { recursive: true });
		await mkdir(foreign);
		await writeFile(pins, 'own pins');
		await writeFile(join(section, 'own.md'), 'own bytes');
		await writeFile(join(foreign, 'secret.md'), 'foreign bytes');
		await withRetentionPaths(
			[own, section, join(own, 'archive'), join(own, 'delivery'), join(own, 'holds'), pins],
			async (present, observe) => {
				expect(present).toEqual([true, true, false, false, false, true]);
				// These attempts run after validation and before the inventory/body read.
				for (const path of [pins, section, own]) {
					let refused = false;
					try {
						await rename(path, `${path}-replaced`);
					} catch {
						refused = true;
					}
					if (!refused) throw new Error(`Guard allowed replacement of ${basename(path)}`);
					expect(refused).toBe(true);
				}
				await refuses(writeFile(pins, 'replacement content'));
				expect(await readFile(pins, 'utf8')).toBe('own pins');
				const inventory = retentionInventory(await observe(0));
				expect(inventory.entries.map((entry) => entry.path)).toEqual(['inbox/own.md']);
				return undefined;
			},
		);
		// Positive control: replacement succeeds after release, and redirected access
		// is rejected before a callback can enumerate foreign names or read bodies.
		await rename(section, `${section}-replaced`);
		await symlink(foreign, section, 'junction');
		let observations = 0;
		await refuses(
			withRetentionPaths([section], () => {
				observations += 1;
				return Promise.resolve();
			}),
		);
		expect(observations).toBe(0);
		await rm(section);
	},
);

windowsTest(
	'pin ancestor and final-component redirects are refused before body access',
	async () => {
		const own = join(root, 'own');
		const foreign = join(root, 'foreign');
		await mkdir(own);
		await mkdir(foreign);
		const pins = join(own, 'pins.json');
		const foreignPins = join(foreign, 'pins.json');
		await writeFile(pins, 'own pins');
		await writeFile(foreignPins, 'foreign pins');
		let observations = 0;
		const observe = async () => {
			observations += 1;
			await readFile(pins);
		};
		await rename(own, `${own}-original`);
		await symlink(foreign, own, 'junction');
		await refuses(withRetentionPaths([pins], observe));
		expect(observations).toBe(0);
		await rm(own);
		await rename(`${own}-original`, own);
		await rename(pins, `${pins}-original`);
		await symlink(foreignPins, pins);
		await refuses(withRetentionPaths([pins], observe));
		expect(observations).toBe(0);
	},
);

windowsTest(
	'missing sections are not accessed if another process creates a redirect later',
	async () => {
		const own = join(root, 'own');
		const section = join(own, 'inbox');
		const foreign = join(root, 'foreign');
		await mkdir(own);
		await mkdir(foreign);
		await writeFile(join(foreign, 'secret.md'), 'foreign bytes');
		await withRetentionPaths(
			[own, section, join(own, 'archive'), join(own, 'delivery'), join(own, 'holds')],
			async (present, observe) => {
				expect(present).toEqual([true, false, false, false, false]);
				await symlink(foreign, section, 'junction');
				const inventory = retentionInventory(await observe(0));
				expect(inventory.entries).toEqual([]);
			},
		);
		await rm(section);
	},
);

windowsTest(
	'failed guarded work releases every handle and never returns a partial result',
	async () => {
		const pins = join(root, 'pins.json');
		await writeFile(pins, 'control');
		await refuses(
			withRetentionPaths([pins], () => Promise.reject(new Error('fixture failure'))),
			'fixture failure',
		);
		await rename(pins, `${pins}-released`);
		expect(await readFile(`${pins}-released`, 'utf8')).toBe('control');
	},
);

windowsTest('failed worker observation cannot return a partial inventory', async () => {
	const own = join(root, 'own');
	await mkdir(join(own, 'inbox'), { recursive: true });
	await writeFile(join(own, 'inbox', 'control.md'), 'body control');
	let accepted = false;
	await refuses(
		withRetentionPaths(
			[
				own,
				join(own, 'inbox'),
				join(own, 'archive'),
				join(own, 'delivery'),
				join(own, 'holds'),
			],
			async (_present, observe) => {
				await observe(-1);
				accepted = true;
			},
		),
	);
	expect(accepted).toBe(false);
	await rename(own, `${own}-released`);
});

windowsTest(
	'held directory ancestors allow delivery, marker and status atomic writers',
	async () => {
		const own = join(root, 'own');
		const inbox = join(own, 'inbox');
		const delivery = join(own, 'delivery');
		await mkdir(inbox, { recursive: true });
		await mkdir(delivery);
		const marker = join(delivery, 'marker.json');
		await writeFile(marker, 'old');
		await withRetentionPaths(
			[own, inbox, join(own, 'archive'), delivery, join(own, 'holds')],
			async (_present, observe) => {
				const sources = [
					join(root, 'incoming.tmp'),
					join(delivery, 'marker.tmp'),
					join(root, 'status.tmp'),
				];
				const targets = [join(inbox, 'message.md'), marker, join(root, 'status.json')];
				await Promise.all(sources.map((source) => writeFile(source, 'new')));
				await Promise.all(
					sources.map((source, index) => rename(source, targets[index] ?? '')),
				);
				for (const target of targets) expect(await readFile(target, 'utf8')).toBe('new');
				const inventory = retentionInventory(await observe(0));
				expect(inventory.entries.map((entry) => entry.path)).toEqual([
					'delivery/marker.json',
					'inbox/message.md',
				]);
			},
		);
	},
);

test.skipIf(process.platform === 'win32')(
	'unsupported platforms refuse before any file access',
	async () => {
		let observations = 0;
		await refuses(
			withRetentionPaths([root], () => {
				observations += 1;
				return Promise.resolve();
			}),
			'requires Windows',
		);
		expect(observations).toBe(0);
	},
);
