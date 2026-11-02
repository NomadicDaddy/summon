/**
 * The refusal both writers of expertise/domain give for a stale revision. Its own dependency-free
 * module because the Team Maintenance renderer recognizes it to offer the stored text, and the
 * renderer bundle must not pull in node:crypto.
 */
export const profileTextStale =
	'Expertise or domain changed after this text was read, so it was not saved. Your text is still here; compare it with the stored text before saving again.';
