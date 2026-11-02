import { expect, test } from 'bun:test';
import { mkdir, readFile } from 'node:fs/promises';

import { registrationAuditPath } from '../src/registration-audit.ts';
import { acquireSessionLock } from '../src/session-lock.ts';
import { loadAgent, recordPath, rememberSession, updateAgentRecord } from '../src/store.ts';
import { profileFor, saveProfile } from '../src/team-maintenance.ts';
import { registrationFixture } from './fixtures/registration.ts';

const { approve, asPm, audit, failure, revision, run, textFile } = registrationFixture();
const stale = 'Expertise or domain changed after this text was read';

test('a stale revision is refused and the newer text survives', async () => {
	const read = await revision();
	await run([
		'edit',
		'beta',
		'--revision',
		read,
		'--expertise-file',
		await textFile('a.txt', 'First'),
	]);
	expect(
		await failure(
			run([
				'edit',
				'beta',
				'--revision',
				read,
				'--expertise-file',
				await textFile('b.txt', 'Second'),
			]),
		),
	).toContain(stale);
	expect((await loadAgent('beta'))?.expertise).toBe('First');
});

test('concurrent session changes, hibernation and a held session lock are preserved', async () => {
	const hibernation = {
		active: true,
		revision: '00000000-0000-4000-8000-000000000001',
		changedAt: 1,
	};
	await updateAgentRecord('beta', (record) => {
		record.hibernation = hibernation;
	});
	const lock = await acquireSessionLock('beta');
	try {
		const path = await textFile('d.txt', 'Edited while running');
		await Promise.all([
			run(['edit', 'beta', '--revision', await revision(), '--domain-file', path]),
			updateAgentRecord('beta', (record) => rememberSession(record, 'concurrent')),
		]);
		const beta = await loadAgent('beta');
		expect(beta?.domain).toBe('Edited while running');
		expect(beta?.sessions.map((session) => session.id)).toContain('concurrent');
		expect(beta?.hibernation).toEqual(hibernation);
		// Still held by its owner: the edit neither took nor released the session lock.
		expect(await acquireSessionLock('beta')).toBeFalsy();
	} finally {
		await lock?.release();
	}
});

test('stale Team Maintenance form versus PM edit, in both orders', async () => {
	// Form loads, PM edits, form saves its own text edit: refused, PM text kept.
	const form = await profileFor('beta');
	const pmText = await textFile('pm.txt', 'PM wrote this');
	const spec = ['beta', '--revision', form.profileRevision ?? '', '--domain-file', pmText];
	const first = await approve(spec);
	await asPm(() => run(['edit', ...spec, '--decision', first]));
	expect(await failure(saveProfile({ ...form, domain: 'Operator form text' }, 'beta'))).toContain(
		stale,
	);
	expect((await loadAgent('beta'))?.domain).toBe('PM wrote this');
	// The same stale form saving an unrelated field leaves the PM's text alone.
	await saveProfile({ ...form, notes: 'Form notes' }, 'beta');
	expect((await loadAgent('beta'))?.domain).toBe('PM wrote this');
	// PM reads and gets approval, the operator form saves new text, then the PM edits from its
	// old revision with that still-valid approval: the edit's own revision check refuses it.
	const again = [
		'beta',
		'--revision',
		await revision(),
		'--domain-file',
		await textFile('again.txt', 'PM again'),
	];
	const yes = await approve(again);
	await saveProfile({ ...(await profileFor('beta')), domain: 'Operator decided' }, 'beta');
	expect(await asPm(() => failure(run(['edit', ...again, '--decision', yes])))).toContain(stale);
	expect((await loadAgent('beta'))?.domain).toBe('Operator decided');
	const entries = await audit();
	expect(entries.filter((entry) => entry.kind === 'intent')).toHaveLength(1);
	expect(entries.filter((entry) => entry.kind === 'applied')).toHaveLength(1);
});

test('an audit write failure changes nothing and is not reported as success', async () => {
	// A directory where the log should be: the append fails before the record is written.
	await mkdir(registrationAuditPath(), { recursive: true });
	const before = await readFile(recordPath('beta'), 'utf8');
	const path = await textFile('d.txt', 'Unaudited');
	expect(
		await failure(run(['edit', 'beta', '--revision', await revision(), '--domain-file', path])),
	).toContain('The audit intent could not be confirmed, so the record was not changed');
	expect(await readFile(recordPath('beta'), 'utf8')).toBe(before);
});

test('Team Maintenance refuses control and bidi characters as the CLI does, and still allows empty', async () => {
	const form = await profileFor('beta');
	for (const domain of ['Bell\u0007', `Flip ${String.fromCodePoint(0x202e)}it`, 'Lone\rreturn'])
		expect(await failure(saveProfile({ ...form, domain }, 'beta'))).toContain(
			'control or bidirectional',
		);
	expect((await loadAgent('beta'))?.domain).toBe('Original domain');
	await saveProfile({ ...form, domain: '' }, 'beta');
	expect((await loadAgent('beta'))?.domain).toBe('');
});
