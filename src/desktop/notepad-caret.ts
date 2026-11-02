/*
 * Where the Notepad caret goes when its text arrives (#7047). Assigning a textarea's value moves
 * the caret to the end, so every open landed at the end of the last line. Phillip asked for the
 * place he left off when the text is what he left, and the top when the text had to come from
 * disk. "What he left" is decided by the text itself, not by a timestamp: a remembered position
 * only applies to the exact text it was recorded against.
 */
export interface CaretMemory {
	hash: string;
	start: number;
	end: number;
	scrollTop: number;
}
export interface CaretStore {
	read: () => string | null;
	write: (value: string) => void;
}

/** A cheap digest of the text, with its length, enough to tell "the text I left" from any other. */
export function textHash(text: string): string {
	let hash = 5381;
	for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
	return `${text.length}:${hash.toString(16)}`;
}

export function rememberCaret(
	store: CaretStore,
	text: string,
	start: number,
	end: number,
	scrollTop: number,
): void {
	try {
		store.write(JSON.stringify({ end, hash: textHash(text), scrollTop, start }));
	} catch {
		/* No memory is the same as a text that changed: the next open starts at the top. */
	}
}

/** The caret for `text`: the remembered place when the text matches, otherwise the top. */
export function placeCaret(
	store: CaretStore,
	text: string,
): { start: number; end: number; scrollTop: number } {
	const top = { end: 0, scrollTop: 0, start: 0 };
	try {
		const raw = store.read();
		if (!raw) return top;
		const memory = JSON.parse(raw) as Partial<CaretMemory>;
		if (
			memory.hash !== textHash(text) ||
			typeof memory.start !== 'number' ||
			typeof memory.end !== 'number' ||
			typeof memory.scrollTop !== 'number'
		)
			return top;
		const clamp = (value: number): number => Math.min(Math.max(0, value), text.length);
		return {
			end: clamp(memory.end),
			scrollTop: Math.max(0, memory.scrollTop),
			start: clamp(memory.start),
		};
	} catch {
		return top;
	}
}
