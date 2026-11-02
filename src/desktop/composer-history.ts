const HISTORY_LIMIT = 50;
const STORAGE_KEY = 'room-composer-history';

export class ComposerHistory {
	readonly entries: string[];
	private position: number;
	private draft = '';
	constructor(entries: string[] = []) {
		this.entries = entries
			.filter((text) => text.trim() && text.length <= 4096)
			.slice(-HISTORY_LIMIT);
		this.position = this.entries.length;
	}
	reset(): void {
		this.position = this.entries.length;
	}
	add(text: string): void {
		if (text.trim() && text.length <= 4096 && this.entries.at(-1) !== text)
			this.entries.push(text);
		this.entries.splice(0, Math.max(0, this.entries.length - HISTORY_LIMIT));
		this.reset();
	}
	move(direction: -1 | 1, current: string): string {
		if (this.position === this.entries.length) this.draft = current;
		this.position = Math.max(0, Math.min(this.entries.length, this.position + direction));
		return this.entries[this.position] ?? this.draft;
	}
}

export function setupComposerHistory(input: HTMLTextAreaElement): (text: string) => void {
	let entries: string[] = [];
	try {
		const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
		if (Array.isArray(saved) && saved.every((value: unknown) => typeof value === 'string'))
			entries = saved;
	} catch {
		/* History is optional; a corrupt/unavailable browser store must not block sending. */
	}
	const history = new ComposerHistory(entries);
	input.addEventListener('input', () => history.reset());
	input.addEventListener('keydown', (event) => {
		if (
			event.isComposing ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.shiftKey ||
			input.selectionStart !== input.selectionEnd
		)
			return;
		const up =
			event.key === 'ArrowUp' && !input.value.slice(0, input.selectionStart).includes('\n');
		const down =
			event.key === 'ArrowDown' && !input.value.slice(input.selectionEnd).includes('\n');
		if (!up && !down) return;
		event.preventDefault();
		input.value = history.move(up ? -1 : 1, input.value);
		const caret = up ? 0 : input.value.length;
		input.setSelectionRange(caret, caret);
	});
	return (text) => {
		history.add(text);
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(history.entries));
		} catch {
			/* Keep the in-memory history if persistence is unavailable. */
		}
	};
}
