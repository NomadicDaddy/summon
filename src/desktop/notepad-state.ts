import type { NotepadSnapshot } from '../notepad.ts';

export interface NotepadDraft {
	text: string;
	revision: string;
}

export function parseNotepadDraft(raw: string | null): NotepadDraft | undefined {
	if (raw === null) return undefined;
	const value: unknown = JSON.parse(raw);
	if (
		!value ||
		typeof value !== 'object' ||
		!('text' in value) ||
		!('revision' in value) ||
		typeof value.text !== 'string' ||
		typeof value.revision !== 'string' ||
		!/^[a-f0-9]{64}$/.test(value.revision)
	)
		throw new Error('Stored notepad draft is invalid; it has been preserved.');
	return { text: value.text, revision: value.revision };
}

/** Keep the local draft separate from a fresh disk version until a human resolves a conflict. */
export class NotepadState {
	base: NotepadSnapshot | undefined;
	text = '';
	conflict: NotepadSnapshot | undefined;

	reconcile(disk: NotepadSnapshot, recovered?: NotepadDraft): void {
		const local = this.base ? { text: this.text, revision: this.base.revision } : recovered;
		const dirty = this.base
			? this.text !== this.base.text
			: !!local && local.text !== disk.text;
		if (!local || !dirty || local.text === disk.text) {
			this.base = disk;
			this.text = disk.text;
			this.conflict = undefined;
			return;
		}
		this.text = local.text;
		this.base ??= { text: disk.text, revision: local.revision };
		if (local.revision !== disk.revision) this.conflict = disk;
		else {
			this.base = disk;
			this.conflict = undefined;
		}
	}

	useDisk(disk: NotepadSnapshot): void {
		this.base = disk;
		this.text = disk.text;
		this.conflict = undefined;
	}

	keepDraft(): void {
		if (!this.conflict) throw new Error('No notepad conflict to resolve.');
		this.base = this.conflict;
		this.conflict = undefined;
	}
}
