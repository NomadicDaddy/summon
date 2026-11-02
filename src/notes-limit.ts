/** Active continuity notes are complete startup context, not a general-purpose archive. */
const NOTES_MAX_BYTES = 16 * 1024;

export function assertNotesLimit(text: string): void {
	if (Buffer.byteLength(text, 'utf8') > NOTES_MAX_BYTES)
		throw new Error(
			'Active notes exceed 16 KiB. Preserve history in your own scratch archive, then compact the notes; no text was truncated.',
		);
}
