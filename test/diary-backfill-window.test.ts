import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { assertBackfillWindowOffline, isBackfillTeamWindow } from '../src/diary-backfill-window.ts';
import { diaryRejection, withDiaryFixture } from './fixtures/diary.ts';

test('the offline matcher requires the exact root argument and the shipped main program', () => {
	const root = process.platform === 'win32' ? 'C:/team root/default' : '/team root/default';
	const command = `"C:/apps/summon/dist/team/main.mjs" "${root}" "bun" "cli.ts"`;
	// The executable preceding main.mjs does not alter the program/root identity.
	expect(isBackfillTeamWindow(`electron.exe ${command}`, root)).toBe(true);
	expect(
		isBackfillTeamWindow(`electron.exe ${command.replace(root, `${root}-other`)}`, root),
	).toBe(false);
	expect(
		isBackfillTeamWindow(`electron.exe ${command.replace('main.mjs', 'renderer.mjs')}`, root),
	).toBe(false);
	expect(
		isBackfillTeamWindow(
			`electron.exe ${command.replace(`"${root}"`, `"--user-data-dir=${root}"`)}`,
			root,
		),
	).toBe(false);
});

test.skipIf(process.platform !== 'win32')(
	'controlled CIM inventory sees a disposable main-shaped child, then clears after its owned exit',
	async () =>
		withDiaryFixture(async (root) => {
			const directory = join(root, 'fixture with spaces', 'dist', 'team');
			await mkdir(directory, { recursive: true });
			const program = join(directory, 'main.mjs');
			await writeFile(program, 'await Bun.sleep(30000);\n');
			const child = Bun.spawn([process.execPath, program, root], {
				stdout: 'pipe',
				stderr: 'pipe',
			});
			try {
				expect((await diaryRejection(assertBackfillWindowOffline(root))).message).toContain(
					'still running',
				);
			} finally {
				child.kill();
				await child.exited;
			}
			expect(await assertBackfillWindowOffline(root)).toBeUndefined();
		}),
);
