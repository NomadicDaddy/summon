import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';

import type { TeamProfile } from '../src/team-maintenance.ts';

import { slugFor } from '../src/store.ts';
import { profileFor, saveProfile } from '../src/team-maintenance.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

const refusal = 'The name operator is reserved for the human operator; choose another name.';

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

/** No registration file of any case may appear for the reserved name. */
async function noOperatorRecord(): Promise<void> {
	expect((await readdir(fixture.records)).filter((name) => /^operator\./i.test(name))).toEqual(
		[],
	);
}

test('operator is reserved in any letter case; names that only contain it are not', () => {
	for (const name of ['operator', 'Operator', '  OPERATOR  '])
		expect(() => slugFor(name)).toThrow(refusal);
	for (const name of ['operators', 'operator-2', 'ops', 'co-operator'])
		expect(slugFor(name)).toBe(name);
});

test.each([
	['creating', ['Operator']],
	['cloning', ['clone', 'alpha', 'operator']],
	['adding the PM', ['--pm', 'OPERATOR', '--using', 'claude']],
])('the CLI refuses %s a member named operator', async (_path, args) => {
	const result = await fixture.run(args);
	expect(result.code).not.toBe(0);
	expect(result.error).toContain(refusal);
	await noOperatorRecord();
});

const newProfile = (name: string): TeamProfile => ({
	memberType: 'teammate',
	canStopResting: false,
	displayName: name,
	name,
	provider: 'claude',
	cwd: fixture.root,
	expertise: 'Testing',
	domain: 'Fixtures',
	backup: '',
	notes: '',
	notesRevision: null,
	profileRevision: null,
	sessionId: '',
});

test('Team Maintenance refuses adding a member named operator', async () => {
	expect(await saveProfile(newProfile('Operator'), null).catch(String)).toContain(refusal);
	await noOperatorRecord();
	// The same form with any other name still creates the member.
	expect(await saveProfile(newProfile('opsdesk'), null)).toBe('opsdesk');
});

test('Team Maintenance refuses renaming a member to operator and keeps the original', async () => {
	const alpha = await profileFor('alpha');
	expect(await saveProfile({ ...alpha, name: 'operator' }, 'alpha').catch(String)).toContain(
		refusal,
	);
	await noOperatorRecord();
	expect((await profileFor('alpha')).name).toBe(alpha.name);
});
