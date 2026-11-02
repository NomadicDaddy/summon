import type { Input } from 'electron';

/** Clipboard paste belongs to Chromium, rather than becoming a CLI control character. */
export function isTextPaste(
	input: Pick<Input, 'type' | 'alt' | 'control' | 'meta' | 'shift' | 'key'>,
): boolean {
	if (input.type !== 'keyDown' || input.alt) return false;
	return (
		((input.control || input.meta) && input.key.toLowerCase() === 'v') ||
		(input.shift && !input.control && !input.meta && input.key === 'Insert')
	);
}
