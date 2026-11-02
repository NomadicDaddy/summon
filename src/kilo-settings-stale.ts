/**
 * The refusal a Team Maintenance save gets when the Kilo model, variant or LM Studio URL changed
 * after the form loaded them. Its own dependency-free module, like profile-text-stale.ts, because
 * the renderer recognizes it to mark the refusal, and the renderer bundle must not pull in
 * node:crypto.
 */
export const kiloSettingsStale =
	'Kilo settings changed while this form was open. Your text is still here; copy your edits, then reload.';
