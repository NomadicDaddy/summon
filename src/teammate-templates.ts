/**
 * The shape of a gallery character. The characters themselves live in `gallery/`, one JSON file
 * each, named for the id inside it.
 *
 * Phillip asked for these at room #4318 and set their character at #4323: inspired by the generic
 * agent definitions lying around the workspace, but written for Summon rather than copied from them.
 * They moved out of this module at #4686, so they can be edited without a rebuild and read as what
 * they are - content rather than code.
 *
 * WHY EVERY DOMAIN ENDS THE SAME WAY. A remit specific enough to be useful also reads as a claim on
 * work that may already belong to somebody - and these are read by a teammate joining a team it has
 * never seen. So each one says what the character is responsible for and then tells it to look
 * before treating anything as its own. That is the balance Phillip asked for at #4329: generic
 * language the teammate can fit to its actual environment, rather than ownership invented here.
 *
 * WHAT THEY DELIBERATELY DO NOT CARRY. No provider, because that is whichever CLI the reader
 * actually has installed. No working directory, which is theirs. No model or permission settings:
 * those are provider-specific, and a template that quietly changed them would be deciding something
 * the user never asked it to decide. Everything here is ordinary text the user edits afterwards.
 *
 * START BLANK IS NOT ONE OF THESE and has no file. It is the absence of a character rather than one
 * of them, so the renderer offers it directly; a record saying "no record" would have to be kept
 * correct forever for no reader's benefit.
 */
export interface TeammateTemplate {
	readonly id: string;
	/** Fills the Name field, and is only a suggestion - the user renames freely. */
	readonly suggestedName: string;
	/** The chip label. Short enough to sit in a row of eight. */
	readonly specialty: string;
	/** One line under the row, saying what this character is for. */
	readonly blurb: string;
	readonly expertise: string;
	readonly domain: string;
}

/**
 * What a read of the gallery directory returned.
 *
 * `warnings` carries what was skipped and why, and it is deliberately not an error: one unreadable
 * file must not cost the operator the other six, and a character that silently vanished would be
 * worse than one plainly reported missing. The renderer shows them; nothing throws.
 */
export interface GallerySnapshot {
	templates: TeammateTemplate[];
	warnings: string[];
}
