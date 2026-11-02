import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { locked } from '../src/mail-files.ts';
import { mailboxPrompt } from '../src/mailbox.ts';
import { saveOperatorIdentity } from '../src/operator-identity.ts';
import { preparePm } from '../src/pm-command.ts';
import { localCursorPath } from '../src/room-cursor.ts';
import { loadAgent, newRecord, saveAgent, updateAgentRecord } from '../src/store.ts';
import { profileFor, saveProfile } from '../src/team-maintenance.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
let path: string;
const previous = process.env.SUMMON_HOME;
const identity = {
	version: 1,
	display: 'Rae',
	aliases: ['Rachel'],
	mentionOnly: ['operator'],
	recipientAliases: ['op', 'me'],
};
async function refused(work: Promise<unknown>): Promise<Error> {
	const result: unknown = await work.catch((error: unknown) => error);
	if (!(result instanceof Error)) throw new Error('Expected identity refusal.');
	return result;
}
async function pendingWriter(): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt++) {
		const files = await readdir(join(fixture.records, 'settings'));
		if (
			files.filter(
				(name) =>
					name.startsWith('operator-identity.json.lock.') && name.endsWith('.pending'),
			).length >= 2
		)
			return;
		await Bun.sleep(10);
	}
	throw new Error('The second identity writer did not reach its lock.');
}
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	path = join(fixture.records, 'settings/operator-identity.json');
});
afterEach(async () => {
	if (previous === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previous;
	await fixture.dispose();
});

test('malformed and externally colliding identity settings keep actual startup prompts available with a safe warning', async () => {
	await mkdir(join(fixture.records, 'settings'));
	const warning = spyOn(console, 'warn').mockImplementation(() => undefined);
	try {
		for (const text of [
			'PRIVATE_CANARY malformed JSON',
			JSON.stringify({ ...identity, aliases: ['Alpha'] }),
		]) {
			await writeFile(path, text);
			for (const slug of ['alpha', 'beta'])
				expect(await mailboxPrompt(slug)).toContain('"for":"Operator"');
			expect(await readFile(path, 'utf8')).toBe(text);
		}
		expect(warning).toHaveBeenCalledTimes(4);
		expect(JSON.stringify(warning.mock.calls)).toContain('Operator identity unavailable');
		expect(JSON.stringify(warning.mock.calls)).not.toContain('PRIVATE_CANARY');
	} finally {
		warning.mockRestore();
	}
});

test('all configured operator aliases refuse new registrations before record and cursor creation', async () => {
	await saveOperatorIdentity(identity);
	for (const name of ['Rae', 'Rachel', 'Op', 'Me']) {
		const slug = name.toLowerCase();
		expect(
			(await refused(saveAgent(slug, newRecord(name, fixture.root, 'claude'), true))).message,
		).toContain('conflicts with the operator identity');
		expect(await Bun.file(join(fixture.records, `${slug}.json`)).exists()).toBe(false);
		expect(await Bun.file(localCursorPath(slug)).exists()).toBe(false);
	}
	expect((await refused(preparePm(['Rae']))).message).toContain(
		'conflicts with the operator identity',
	);
});

test('the real Maintenance PM rename refuses operator names and preserves record and notes bytes', async () => {
	const member = await loadAgent('alpha');
	if (!member) throw new Error('Missing fixture member.');
	member.memberType = 'pm';
	member.displayName = 'Harbor';
	await saveAgent('alpha', member);
	await saveOperatorIdentity(identity);
	const original = await readFile(join(fixture.records, 'alpha.json'), 'utf8');
	for (const displayName of ['Rae', 'Rachel', 'Op', 'Me']) {
		const profile = await profileFor('alpha');
		expect(
			(await refused(saveProfile({ ...profile, displayName }, 'alpha'))).message,
		).toContain('conflicts with the operator identity');
		expect(await readFile(join(fixture.records, 'alpha.json'), 'utf8')).toBe(original);
		expect(await Bun.file(join(fixture.records, 'alpha.md')).exists()).toBe(false);
	}
});

test('an identity fault does not block ordinary existing record updates, and valid rename can recover an external collision', async () => {
	await saveOperatorIdentity(identity);
	const member = await loadAgent('alpha');
	if (!member) throw new Error('Missing fixture member.');
	member.memberType = 'pm';
	member.displayName = 'Rae';
	await writeFile(join(fixture.records, 'alpha.json'), JSON.stringify(member));
	await updateAgentRecord('alpha', (record) => {
		record.cwd = fixture.root;
	});
	await updateAgentRecord('alpha', (record) => {
		record.displayName = 'Harbor';
	});
	expect(await mailboxPrompt('alpha')).toContain('"for":"Rae"');
	await writeFile(path, 'malformed');
	await updateAgentRecord('alpha', (record) => {
		record.cwd = fixture.root;
	});
	expect((await loadAgent('alpha'))?.displayName).toBe('Harbor');
});

test('create checks absence inside the real identity lock and never overwrites an interleaved writer', async () => {
	let pending: Promise<unknown> | undefined;
	const concurrent = JSON.stringify({ ...identity, display: 'Zora', aliases: [] });
	await locked(`${path}.lock`, async () => {
		pending = saveOperatorIdentity(identity, true);
		await pendingWriter();
		await writeFile(path, concurrent);
	});
	if (!pending) throw new Error('Missing pending create.');
	expect((await refused(pending)).message).toContain('already exists');
	expect(await readFile(path, 'utf8')).toBe(concurrent);
});

test('a pending registration rechecks a newly saved operator namespace under the same lock', async () => {
	let pending: Promise<unknown> | undefined;
	await locked(`${path}.lock`, async () => {
		pending = saveAgent('rae', newRecord('Rae', fixture.root, 'claude'), true);
		await pendingWriter();
		await writeFile(path, JSON.stringify(identity));
	});
	if (!pending) throw new Error('Missing pending registration.');
	expect((await refused(pending)).message).toContain('conflicts with the operator identity');
	expect(await Bun.file(join(fixture.records, 'rae.json')).exists()).toBe(false);
});

test('actual create CLI is operator-only and preserves an existing identity byte for byte', async () => {
	const input = join(fixture.root, 'identity.json');
	await writeFile(input, JSON.stringify(identity));
	const command = ['--operator-identity', 'create', '--file', input];
	expect((await fixture.run(command, 'alpha')).code).toBe(1);
	expect(await Bun.file(path).exists()).toBe(false);
	expect((await fixture.run(command)).code).toBe(0);
	const original = await readFile(path, 'utf8');
	expect((await fixture.run(command)).code).toBe(1);
	expect(await readFile(path, 'utf8')).toBe(original);
});
