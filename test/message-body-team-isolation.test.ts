import { expect, test } from 'bun:test';
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { newRecord } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

test('private body input is refused across default and named teams, including same names and links', async () => {
	const fixture = await mailHarness();
	try {
		const base = fixture.records;
		const own = join(base, 'team-one');
		const other = join(base, process.platform === 'win32' ? 'TEAM-TWO' : 'team-two');
		for (const root of [own, other]) {
			await mkdir(root);
			await writeFile(
				join(root, 'alpha.json'),
				JSON.stringify(newRecord('alpha', fixture.root, 'claude')),
			);
		}
		await mkdir(join(own, 'runtime/alpha'), { recursive: true });
		await writeFile(
			join(own, 'runtime/alpha/activity.json'),
			JSON.stringify({
				workingOn: '',
				state: 'idle',
				updatedAt: new Date().toISOString(),
				nonce: 'test-launch',
			}),
		);
		const targets: string[] = [];
		for (const root of [base, other]) {
			for (const folder of [
				'mailboxes/alpha/inbox',
				'runtime/alpha',
				'scratch/alpha',
				'scratch/beta',
			]) {
				const directory = join(root, folder);
				await mkdir(directory, { recursive: true });
				const path = join(directory, 'private.txt');
				await writeFile(path, 'synthetic other-team private body');
				targets.push(path);
			}
		}
		const alias = join(fixture.root, 'outside alias');
		await symlink(
			join(other, 'scratch/alpha'),
			alias,
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		targets.push(join(alias, 'private.txt'));
		// Parent recognition also works when a custom-root named session has no base override.
		const overrides = { SUMMON_HOME: own, SUMMON_TEAMS_HOME: '' };
		for (const path of targets) {
			const result = await fixture.run(
				['--mail', 'send-self', 'alpha', '--body-file', path],
				'alpha',
				overrides,
			);
			expect(result.code).toBe(1);
			expect(result.error).toContain('private storage');
		}
		// A team-local shared folder is public, while same-named private folders in another team are not.
		for (const path of [
			join(own, 'scratch/alpha/body.txt'),
			join(other, 'scratch/shared/body.txt'),
			join(fixture.root, 'domain/body.txt'),
		]) {
			await mkdir(join(path, '..'), { recursive: true });
			await writeFile(path, 'allowed synthetic body');
			const result = await fixture.run(
				['--mail', 'send-self', 'alpha', '--body-file', path],
				'alpha',
				overrides,
			);
			expect(result.code).toBe(0);
		}
		expect(await readdir(join(own, 'mailboxes/alpha/inbox'))).toHaveLength(3);
		const fromDefault = await fixture.run(
			['--room', 'send', '--body-file', targets[4] ?? ''],
			'alpha',
			{ SUMMON_TEAMS_HOME: base },
		);
		expect(fromDefault.code).toBe(1);
	} finally {
		await fixture.dispose();
	}
});
