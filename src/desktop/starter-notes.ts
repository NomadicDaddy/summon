/**
 * What a new teammate's notes file starts as, so it starts with a rule in it rather than empty.
 *
 * Phillip asked for this at #4713 and agreed it was needed at #4719. The evidence is from the same
 * morning: three teammates could not start, their notes files had reached 97, 83 and 57 KB, and the
 * folding exercise that followed found what had actually been worth keeping. Dave checked 56,890
 * bytes against every record in his domain and FIVE FACTS survived.
 *
 * WHY A STARTER AT ALL, rather than a policy anyone has to enforce. My own file is 7 KB after months
 * of the same work that grew the others past 50, and the reason is not discipline: it was migrated
 * with one sentence written into it saying the board is canon for open items and what follows is
 * the part a card cannot hold. I have been obeying that sentence ever since. Files that began empty
 * grew; the file that began with a rule did not. This is that sentence, made standard.
 *
 * IT IS A DEFAULT AND NOT A FORM. It fills the Notes field when adding a teammate, where the
 * operator can read it, edit it or delete it before saving - nothing is written behind anyone's
 * back, and a teammate who wants an empty file still gets one by clearing the box.
 */
const STARTER_NOTES = `# Notes

Kept across sessions, for the next one of me. Expertise and domain are injected at launch - do not
repeat them here.

**The test: if I delete this line, does anything else in the world still know it?** Commits, the
board, the room and the diary already hold run accounts, findings and what changed. Those go. What
stays is the part a card cannot hold.

## Current work

What is open, and what the next session has to know to pick it up safely.

## Decisions and traps

Why something is the way it is, where the reason is not obvious from the code. Instruments that lie
on this machine. What would do real damage if someone new tried it.

## Corrections

**What I believed and stopped believing.** This is the least duplicated thing in the file: when a
wrong answer is corrected, every document downstream is quietly fixed to match the right one, so
the abandoned belief survives only where someone wrote down abandoning it. Nothing else records it.

## Where the records are

Pointers to the authoritative place for each thing - board cards, docs, reports - rather than copies
of what they say.
`;

/**
 * The profile a brand-new teammate's form starts from.
 *
 * It lives beside the starter text rather than inside the dialog because it IS mostly the starter
 * text: everything else here is an empty string, and the one field with a value is the one this
 * module exists to supply. Keeping them together means the default and the reason for it are read
 * in one place.
 */
export function blankProfile(provider: string): {
	backup: string;
	cwd: string;
	domain: string;
	expertise: string;
	name: string;
	notes: string;
	notesRevision: null | string;
	profileRevision: null | string;
	provider: string;
	sessionId: string;
} {
	return {
		backup: '',
		cwd: '',
		domain: '',
		expertise: '',
		name: '',
		notes: STARTER_NOTES,
		notesRevision: null,
		profileRevision: null,
		provider,
		sessionId: '',
	};
}
