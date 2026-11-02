import { expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pruneTeamLogs } from '../src/team-window.ts';

test('team log retention keeps five newest launches and unrelated runtime files', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-log-retention-'));
	try {
		for (let index = 0; index < 8; index++) {
			const path = join(root, `launch-${index}.log`);
			await writeFile(path, 'test log');
			await utimes(path, 1000 + index, 1000 + index);
		}
		await writeFile(join(root, 'other.log'), 'preserve');
		await writeFile(join(root, 'launch-1.json'), 'preserve');
		await pruneTeamLogs(root);
		expect((await readdir(root)).sort()).toEqual([
			'launch-1.json',
			'launch-3.log',
			'launch-4.log',
			'launch-5.log',
			'launch-6.log',
			'launch-7.log',
			'other.log',
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
