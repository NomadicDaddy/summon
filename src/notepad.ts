import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import { storageRoot } from './store.ts';

export interface NotepadSnapshot {
	text: string;
	revision: string;
}
const MAX_BYTES = 256 * 1024;
const path = (): string => join(storageRoot(), 'notepad', 'note.md');

function snapshot(text: string): NotepadSnapshot {
	if (Buffer.byteLength(text, 'utf8') > MAX_BYTES)
		throw new Error('Notepad exceeds 256 KiB. Copy some text elsewhere before saving.');
	return { text, revision: createHash('sha256').update(text).digest('hex') };
}

export async function readNotepad(): Promise<NotepadSnapshot> {
	operatorOnly();
	return snapshot((await optionalText(path())) ?? '');
}

export async function saveNotepad(text: unknown, revision: unknown): Promise<NotepadSnapshot> {
	operatorOnly();
	if (typeof text !== 'string' || typeof revision !== 'string')
		throw new Error('Invalid notepad save.');
	const next = snapshot(text);
	return locked(`${path()}.lock`, async () => {
		const current = await readNotepad();
		if (current.revision !== revision)
			throw new Error(
				'Notepad changed on disk. Copy your draft, then reload to reconcile it.',
			);
		await atomicWrite(path(), next.text);
		return next;
	});
}
