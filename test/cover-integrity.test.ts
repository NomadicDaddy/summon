import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { removeAgent } from '../src/remove.ts';
import { loadAgent, newRecord } from '../src/store.ts';
import { profileFor, saveProfile } from '../src/team-maintenance.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previous = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

test('malformed unrelated cover does not abort removal or prevent later reference cleanup', async () => {
	const beta = newRecord('beta', fixture.root, 'claude');
	beta.backup = 'Dave Ops';
	await writeFile(join(fixture.records, 'beta.json'), JSON.stringify(beta));
	const gamma = newRecord('gamma', fixture.root, 'codex');
	gamma.backup = 'ALPHA';
	await writeFile(join(fixture.records, 'gamma.json'), JSON.stringify(gamma));
	await removeAgent('alpha');
	expect(await loadAgent('alpha')).toBeUndefined();
	expect((await loadAgent('gamma'))?.backup).toBeUndefined();
	expect((await loadAgent('beta'))?.backup).toBe('Dave Ops');
});

test.each(['David', 'Dave Ops'])(
	'removal clears exact stored display-name cover %s',
	async (name) => {
		const alpha = newRecord('alpha', fixture.root, 'claude');
		alpha.name = name;
		await writeFile(join(fixture.records, 'alpha.json'), JSON.stringify(alpha));
		const beta = newRecord('beta', fixture.root, 'codex');
		beta.backup = name;
		await writeFile(join(fixture.records, 'beta.json'), JSON.stringify(beta));
		await removeAgent('alpha');
		expect((await loadAgent('beta'))?.backup).toBeUndefined();
	},
);

test.each(['David', 'Dave Ops'])(
	'new cover refuses mismatched stored name %s without rewriting it',
	async (name) => {
		const alpha = newRecord('alpha', fixture.root, 'claude');
		alpha.name = name;
		const original = JSON.stringify(alpha);
		await writeFile(join(fixture.records, 'alpha.json'), original);
		const beta = newRecord('beta', fixture.root, 'codex');
		await writeFile(join(fixture.records, 'beta.json'), JSON.stringify(beta));
		const profile = await profileFor('beta');
		expect(await saveProfile({ ...profile, backup: 'alpha' }, 'beta').catch(String)).toContain(
			'does not match its file name',
		);
		expect((await loadAgent('beta'))?.backup).toBeUndefined();
		expect(await readFile(join(fixture.records, 'alpha.json'), 'utf8')).toBe(original);
	},
);

test.each(['David', 'Dave Ops'])(
	'list diagnoses mismatched name %s and still lists readable records',
	async (name) => {
		const alpha = newRecord('alpha', fixture.root, 'claude');
		alpha.name = name;
		await writeFile(join(fixture.records, 'alpha.json'), JSON.stringify(alpha));
		const child = Bun.spawn({
			cmd: [process.execPath, resolve('src/cli.ts'), 'list'],
			env: { ...process.env, SUMMON_HOME: fixture.records },
			stdout: 'pipe',
			stderr: 'pipe',
			stdin: 'ignore',
			windowsHide: true,
		});
		const [code, out, err] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(code).toBe(1);
		expect(err).toContain('alpha.json');
		expect(err).toContain(JSON.stringify(name));
		expect(out).toContain('beta');
		expect(out).toContain(name);
	},
);
