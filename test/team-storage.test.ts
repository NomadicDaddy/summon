import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { acquireSessionLock, isAgentRunning } from '../src/session-lock.ts';
import { cliHarness } from './fixtures/cli-harness.ts';

let fixture: Awaited<ReturnType<typeof cliHarness>>;
const original = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await cliHarness();
});
afterEach(async () => {
	if (original === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = original;
	await fixture.dispose();
});

test('named team initializes only its own store, preserves default data, and reuses canonical names', async () => {
	await fixture.seed('claude');
	await writeFile(join(fixture.records, 'AGENTS.md'), 'default sentinel');
	const initial = await readFile(join(fixture.records, 'member.json'), 'utf8');
	const launch = await fixture.invoke(['--team', 'Testing']);
	expect(launch.code).toBe(0);
	const target = join(fixture.teams, 'team-testing');
	expect(launch.launches[0]?.cmd).toContain(target);
	expect(await readFile(join(fixture.records, 'AGENTS.md'), 'utf8')).toBe('default sentinel');
	expect(await readFile(join(fixture.records, 'member.json'), 'utf8')).toBe(initial);
	expect((await readdir(target)).sort()).toEqual(['AGENTS.md', 'runtime']);
	expect((await fixture.invoke(['--team', 'testing'])).launches[0]?.cmd).toContain(target);
	expect((await fixture.invoke(['--team'])).launches[0]?.cmd).toContain(fixture.records);
	for (const name of ['runtime', 'con']) {
		const named = await fixture.invoke(['--team', name]);
		expect(named.code).toBe(0);
		expect(named.launches[0]?.cmd).toContain(join(fixture.teams, `team-${name}`));
	}
	// Five operator starts, each running the real scratch expiry worker (about 1.5 s on Windows).
}, 30_000);

test('named teams launched from a team operator shell are siblings, not nested stores', async () => {
	await fixture.invoke(['--team', 'one']);
	const result = await fixture.invoke(['--team', 'two'], {
		SUMMON_HOME: join(fixture.teams, 'team-one'),
	});
	expect(result.code).toBe(0);
	expect(result.launches[0]?.cmd).toContain(join(fixture.teams, 'team-two'));
	expect(await Bun.file(join(fixture.teams, 'team-one', 'team-two', 'AGENTS.md')).exists()).toBe(
		false,
	);
});

test('invalid names and agent callers cannot select or initialize a different registry', async () => {
	for (const name of ['..', '../outside', 'C:\\outside', 'name.', '', 'x'.repeat(65)]) {
		const result = await fixture.invoke(['--team', name]);
		expect(result.code).toBe(1);
		expect(result.launches).toHaveLength(0);
	}
	const denied = await fixture.invoke(['--team', 'forbidden'], { SUMMON_AGENT: 'member' });
	expect(denied.code).toBe(1);
	expect(await Bun.file(join(fixture.teams, 'team-forbidden', 'AGENTS.md')).exists()).toBe(false);
	expect(await readdir(fixture.records)).toEqual([]);
});

test('directory junctions cannot redirect a named team into another registry', async () => {
	await mkdir(fixture.teams);
	await symlink(
		fixture.project,
		join(fixture.teams, 'team-linked'),
		process.platform === 'win32' ? 'junction' : 'dir',
	);
	const result = await fixture.invoke(['--team', 'linked']);
	expect(result.code).toBe(1);
	expect(result.stderr).toContain('directory link');
	expect(await Bun.file(join(fixture.project, 'AGENTS.md')).exists()).toBe(false);
});

test('same-named agents in two team stores have independent session locks', async () => {
	await fixture.invoke(['--team', 'one']);
	await fixture.invoke(['--team', 'two']);
	process.env.SUMMON_HOME = join(fixture.teams, 'team-one');
	const first = await acquireSessionLock('member');
	if (!first) throw new Error('Missing first fixture lock');
	let second: Awaited<ReturnType<typeof acquireSessionLock>>;
	try {
		process.env.SUMMON_HOME = join(fixture.teams, 'team-two');
		expect(await isAgentRunning('member')).toBe(false);
		second = await acquireSessionLock('member');
		expect(second).toBeDefined();
		expect(await isAgentRunning('member')).toBe(true);
	} finally {
		await second?.release();
		await first.release();
	}
});
