import type { NotepadSnapshot } from '../notepad.ts';
import type { NotepadNoticeState } from './notepad-notice.ts';
import type { NotepadDraft } from './notepad-state.ts';

import { readableError } from './ipc-error.ts';
import { NotepadState, parseNotepadDraft } from './notepad-state.ts';

interface NotepadPort {
	read: () => Promise<NotepadSnapshot>;
	save: (text: string, revision: string) => Promise<NotepadSnapshot>;
}
interface NotepadRecovery {
	read: () => string | null;
	write: (text: string) => void;
	clear: () => void;
}

/** Coordinates fresh reads, draft recovery and optimistic saves without choosing a conflict. */
export class NotepadController {
	readonly state = new NotepadState();
	status = 'Loading…';
	loading = false;
	private verified = false;
	private recoveryChecked = false;
	private invalidDraft = false;
	private invalidRaw: string | null | undefined;
	private failure: string | undefined;
	private keptRevision: string | undefined;
	private pending: Promise<void> | undefined;
	private reading: Promise<void> | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly port: NotepadPort;
	private readonly recovery: NotepadRecovery;
	private readonly changed: () => void;

	constructor(port: NotepadPort, recovery: NotepadRecovery, changed: () => void) {
		this.port = port;
		this.recovery = recovery;
		this.changed = changed;
	}

	get saving(): boolean {
		return this.pending !== undefined;
	}
	get editorDisabled(): boolean {
		return this.loading || !this.state.base || this.invalidDraft;
	}
	get notice(): NotepadNoticeState {
		const disabled = this.loading || this.saving;
		if (this.failure) return { kind: 'read-failure', error: this.failure, disabled };
		if (this.invalidDraft) return { kind: 'invalid-draft', disabled };
		if (this.state.conflict)
			return {
				kind: 'conflict',
				disabled: disabled || !this.verified,
				diskText: this.state.conflict.text,
				diskRevision: this.state.conflict.revision,
				changedAgain:
					this.keptRevision !== undefined &&
					this.keptRevision !== this.state.conflict.revision,
			};
		return { kind: 'quiet' };
	}

	dispose(): void {
		clearTimeout(this.timer);
	}
	private storeDraft(): boolean {
		if (!this.state.base || this.invalidDraft) return false;
		try {
			this.recovery.write(
				JSON.stringify({ text: this.state.text, revision: this.state.base.revision }),
			);
			return true;
		} catch {
			return false;
		}
	}
	edit(text: string): void {
		if (this.editorDisabled) return;
		this.state.text = text;
		this.status = this.storeDraft()
			? 'Unsaved'
			: 'Draft recovery unavailable. Keep this window open until saved.';
		this.dispose();
		if (this.state.conflict) this.status = 'Autosave paused until you choose';
		else if (this.verified && !this.invalidDraft && !this.failure)
			this.timer = setTimeout(() => void this.save(), 400);
		this.changed();
	}

	load(discard = false): Promise<void> {
		this.dispose();
		this.loading = true;
		this.verified = false;
		this.status = 'Loading…';
		// Each open gets its own fresh read, even when a preceding open is still loading.
		const job = Promise.resolve(this.reading)
			.then(() => this.read(discard))
			.finally(() => {
				if (this.reading === job) {
					this.reading = undefined;
					this.loading = false;
				}
				this.changed();
			});
		this.reading = job;
		this.changed();
		return job;
	}
	private async read(discard: boolean): Promise<void> {
		this.verified = false;
		this.status = 'Loading…';
		this.changed();
		try {
			await this.pending;
			const before = discard ? this.recovery.read() : undefined;
			const disk = await this.port.read();
			if (discard) {
				if (
					this.recovery.read() !== before ||
					(this.invalidRaw !== undefined && before !== this.invalidRaw)
				)
					throw new Error('Stored draft changed. Retry before discarding it.');
				this.recovery.clear();
				this.state.useDisk(disk);
				this.invalidDraft = false;
				this.invalidRaw = undefined;
				this.recoveryChecked = true;
				this.keptRevision = undefined;
				this.status = 'Loaded the disk version. Your draft was discarded.';
			} else {
				let recovered: NotepadDraft | undefined;
				if (!this.recoveryChecked) {
					this.invalidRaw = this.recovery.read();
					try {
						recovered = parseNotepadDraft(this.invalidRaw);
					} catch {
						this.invalidDraft = true;
						this.failure = undefined;
						this.status = 'Saving is off until the stored draft is resolved';
						return;
					}
					this.recoveryChecked = true;
					this.invalidRaw = undefined;
					this.invalidDraft = false;
				}
				const previous = this.state.base;
				const clean = !previous || this.state.text === previous.text;
				this.state.reconcile(disk, recovered);
				this.status = this.state.conflict
					? 'Autosave paused until you choose'
					: this.state.text !== disk.text
						? 'Recovered unsaved draft'
						: clean && previous && previous.revision !== disk.revision
							? 'Updated from disk'
							: 'Saved';
				if (this.state.text === disk.text) {
					try {
						this.recovery.clear();
					} catch {
						this.status += '. Recovery cleanup unavailable.';
					}
				}
			}
			this.failure = undefined;
			this.verified = true;
		} catch (error: unknown) {
			this.failure = readableError(error);
			this.status = 'Saving is off until the notepad can be verified';
		}
	}

	keepDraft(): void {
		if (
			!this.verified ||
			this.loading ||
			this.pending ||
			this.invalidDraft ||
			!this.state.conflict
		)
			return;
		this.keptRevision = this.state.conflict.revision;
		this.state.keepDraft();
		this.storeDraft();
		this.status = 'Keeping your draft. The next save replaces the disk version.';
		this.changed();
		void this.save();
	}
	save(announce = false): Promise<void> {
		this.dispose();
		if (this.pending) return this.pending;
		if (
			!this.state.base ||
			this.loading ||
			!this.verified ||
			this.invalidDraft ||
			this.failure ||
			this.state.conflict
		) {
			if (announce) {
				this.status =
					this.state.conflict && !this.failure && !this.invalidDraft
						? 'Choose Keep my draft or Load disk version first.'
						: 'Saving is off until the notepad can be read and recovery is resolved';
				this.changed();
			}
			return Promise.resolve();
		}
		if (this.state.text === this.state.base.text) return Promise.resolve();
		this.status = 'Saving…';
		// The job is assigned before either IPC call can throw synchronously.
		const job: Promise<void> = Promise.resolve()
			.then(async () => {
				try {
					while (this.state.base && this.state.text !== this.state.base.text) {
						this.state.base = await this.port.save(
							this.state.text,
							this.state.base.revision,
						);
						this.keptRevision = undefined;
						this.storeDraft();
					}
					this.status = 'Saved';
					try {
						this.recovery.clear();
					} catch {
						this.status += '. Recovery cleanup unavailable.';
					}
				} catch (error: unknown) {
					this.status = `Save failed: ${readableError(error)} Your draft remains in this window.`;
					try {
						this.state.reconcile(await this.port.read());
						this.verified = true;
						if (this.state.conflict) this.status = 'Autosave paused until you choose';
					} catch (readError: unknown) {
						this.verified = false;
						this.failure = readableError(readError);
						this.status = 'Saving is off until the notepad can be verified';
					}
				}
			})
			.finally(() => {
				if (this.pending === job) this.pending = undefined;
				this.changed();
			});
		this.pending = job;
		this.changed();
		return job;
	}
}
