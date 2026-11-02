import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readNotepad, saveNotepad } from '../src/notepad.ts';

async function rejected(work: Promise<unknown>, message: string): Promise<void> {
	const error = await work.then(
		() => '',
		(value: unknown) => String(value),
	);
	expect(error).toContain(message);
}

test('notepad retains text, refuses stale concurrent saves and isolates teams', async () => {
	const root = await mkdtemp(join(tmpdir(), 'summon-notepad-'));
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = root;
	try {
		const empty = await readNotepad();
		expect(empty.text).toBe('');
		const note = await saveNotepad('Line one\nUnicode: café 📝\n', empty.revision);
		expect(await readNotepad()).toEqual(note);
		expect(await readFile(join(root, 'notepad', 'note.md'), 'utf8')).toBe(note.text);
		const writers = await Promise.allSettled([
			saveNotepad('Writer one', note.revision),
			saveNotepad('Writer two', note.revision),
		]);
		expect(writers.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(writers.filter((result) => result.status === 'rejected')).toHaveLength(1);
		const winner = await readNotepad();
		expect(['Writer one', 'Writer two']).toContain(winner.text);
		await rejected(saveNotepad('Lost update', note.revision), 'changed on disk');
		await rejected(saveNotepad('é'.repeat(131073), winner.revision), '256 KiB');
		await rejected(saveNotepad(null, winner.revision), 'Invalid');
		expect(await readNotepad()).toEqual(winner);
		process.env.SUMMON_HOME = join(root, 'team-other');
		expect((await readNotepad()).text).toBe('');
		process.env.SUMMON_HOME = root;
		expect((await saveNotepad('', winner.revision)).text).toBe('');
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await rm(root, { recursive: true, force: true });
	}
});
