import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cloneAgent } from '../src/clone.ts';
import {
	appendNote,
	newRecord,
	notesPath,
	readNotes,
	recordPath,
	saveAgent,
} from '../src/store.ts';
import { profileFor, saveProfile } from '../src/team-maintenance.ts';

test.each(['claude', 'codex', 'grok', 'kilo'] as const)(
	'%s complete UTF-8 notes fit exactly; appends, profiles and clones cannot exceed the cap',
	async (provider) => {
		const root = await mkdtemp(join(tmpdir(), 'summon-notes-limit-'));
		const before = process.env.SUMMON_HOME;
		process.env.SUMMON_HOME = root;
		try {
			await saveAgent('writer', newRecord('Writer', root, provider));
			const exact = '😀'.repeat(4096);
			expect(Buffer.byteLength(exact)).toBe(16 * 1024);
			await writeFile(notesPath('writer'), exact);
			expect(await readNotes('writer')).toBe(exact);
			const record = await readFile(recordPath('writer'), 'utf8');
			expect(appendNote('writer', 'x')).rejects.toThrow('16 KiB');
			const profile = await profileFor('writer');
			expect(
				saveProfile({ ...profile, domain: 'must not save', notes: exact + 'x' }, 'writer'),
			).rejects.toThrow('16 KiB');
			expect(cloneAgent('Writer', 'Copy')).rejects.toThrow('16 KiB');
			expect(await Bun.file(recordPath('copy')).exists()).toBe(false);
			expect(await Bun.file(notesPath('copy')).exists()).toBe(false);
			expect(await readFile(recordPath('writer'), 'utf8')).toBe(record);
			expect(await readFile(notesPath('writer'), 'utf8')).toBe(exact);
			await saveProfile({ ...profile, notes: 'Concise handoff' }, 'writer');
			expect(await readNotes('writer')).toBe('Concise handoff');
		} finally {
			if (before === undefined) delete process.env.SUMMON_HOME;
			else process.env.SUMMON_HOME = before;
			await rm(root, { recursive: true, force: true });
		}
	},
);
