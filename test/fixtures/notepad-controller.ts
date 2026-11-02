import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { NotepadController } from '../../src/desktop/notepad-controller.ts';
import { readNotepad, saveNotepad } from '../../src/notepad.ts';

export async function notepadHarness() {
	const root = await mkdtemp(join(tmpdir(), 'summon-notepad-controller-'));
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = root;
	await mkdir(join(root, 'notepad'), { recursive: true });
	await saveNotepad('original', (await readNotepad()).revision);
	let raw: string | null = null;
	let reads = 0;
	let saves = 0;
	const port = {
		read: async () => {
			reads++;
			return readNotepad();
		},
		save: async (text: string, revision: string) => {
			saves++;
			return saveNotepad(text, revision);
		},
	};
	const recovery = {
		read: (): string | null => raw,
		write: (value: string): void => {
			raw = value;
		},
		clear: (): void => {
			raw = null;
		},
	};
	const controller = new NotepadController(port, recovery, () => {});
	return {
		controller,
		port,
		recovery,
		counts: () => ({ reads, saves }),
		raw: () => raw,
		setRaw: (value: string | null): void => {
			raw = value;
		},
		disk: readNotepad,
		outside: async (text: string) => saveNotepad(text, (await readNotepad()).revision),
		async dispose() {
			controller.dispose();
			if (previous === undefined) delete process.env.SUMMON_HOME;
			else process.env.SUMMON_HOME = previous;
			if (
				dirname(resolve(root)) !== resolve(tmpdir()) ||
				!basename(root).startsWith('summon-notepad-controller-')
			)
				throw new Error('Invalid fixture cleanup boundary.');
			await rm(root, { recursive: true, force: true });
		},
	};
}
