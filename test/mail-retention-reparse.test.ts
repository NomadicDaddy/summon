import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { withRetentionPaths } from '../src/mail-retention-access.ts';

test.skipIf(process.platform !== 'win32')(
	'in-place junction conversion cannot redirect a held section observation',
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'summon-retention-reparse-'));
		if (
			dirname(resolve(root)) !== resolve(tmpdir()) ||
			!basename(root).startsWith('summon-retention-reparse-')
		)
			throw new Error('Wrong reparse fixture root.');
		const own = join(root, 'own');
		const inbox = join(own, 'inbox');
		const foreign = join(root, 'foreign');
		try {
			await mkdir(inbox, { recursive: true });
			await mkdir(foreign);
			await writeFile(join(foreign, 'secret.md'), 'foreign body');
			let converted = false;
			let observed = false;
			let failure: unknown;
			try {
				await withRetentionPaths(
					[own, inbox, join(own, 'archive'), join(own, 'delivery'), join(own, 'holds')],
					async (_present, observe) => {
						const child = Bun.spawn(
							[
								'pwsh',
								'-NoProfile',
								'-NonInteractive',
								'-File',
								join(import.meta.dir, 'fixtures/retention-path-probe.ps1'),
								'-Mode',
								'reparse',
								'-TestRoot',
								root,
								'-Path',
								inbox,
								'-Target',
								foreign,
							],
							{ stdout: 'pipe', stderr: 'pipe', windowsHide: true },
						);
						const [output, error, code] = await Promise.all([
							new Response(child.stdout).text(),
							new Response(child.stderr).text(),
							child.exited,
						]);
						if (code !== 0) throw new Error(`Reparse control failed: ${error}`);
						converted = (JSON.parse(output) as { converted: boolean }).converted;
						await observe(0);
						observed = true;
					},
				);
			} catch (error: unknown) {
				failure = error;
			}
			expect(converted).toBe(true);
			expect(failure).toBeInstanceOf(Error);
			expect(observed).toBe(false);
			// Positive control: the actual directory conversion points to the foreign fixture.
			expect(await readFile(join(inbox, 'secret.md'), 'utf8')).toBe('foreign body');
			await rm(inbox);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
