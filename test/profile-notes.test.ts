import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendNote, newRecord, notesPath, recordPath, saveAgent } from '../src/store.ts';
import { profileFor, saveProfile } from '../src/team-maintenance.ts';

test('stale profile fields preserve appended notes and conflicting edits preserve both files', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-profile-notes-'));
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = root;
	try {
		await saveAgent('writer', newRecord('Writer', root, 'codex'));
		await appendNote('writer', 'Original');
		const stale = await profileFor('writer');
		await Promise.all([
			appendNote('writer', 'Added while editing'),
			saveProfile({ ...stale, domain: 'Updated domain' }, 'writer'),
		]);
		const refreshed = await profileFor('writer');
		expect(refreshed.domain).toBe('Updated domain');
		expect(refreshed.notes).toBe('Original\nAdded while editing\n');
		expect(refreshed.notesRevision).not.toBe(stale.notesRevision);
		const beforeRecord = await readFile(recordPath('writer'), 'utf8');
		const beforeNotes = await readFile(notesPath('writer'), 'utf8');
		let failure: unknown;
		await saveProfile(
			{ ...stale, domain: 'Must not save', notes: 'Operator edit' },
			'writer',
		).catch((error: unknown) => {
			failure = error;
		});
		expect(String(failure)).toContain('Notes changed while this form was open');
		expect(await readFile(recordPath('writer'), 'utf8')).toBe(beforeRecord);
		expect(await readFile(notesPath('writer'), 'utf8')).toBe(beforeNotes);
		await saveProfile({ ...refreshed, notes: 'Deliberate edit after reload' }, 'writer');
		expect((await profileFor('writer')).notes).toBe('Deliberate edit after reload');
		const baseline = await profileFor('writer');
		const competing = await Promise.allSettled([
			saveProfile({ ...baseline, notes: 'First editor' }, 'writer'),
			saveProfile({ ...baseline, notes: 'Second editor' }, 'writer'),
		]);
		expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(competing.filter((result) => result.status === 'rejected')).toHaveLength(1);
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await rm(root, { recursive: true, force: true });
	}
});
