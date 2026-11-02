export interface TeamProfile {
	claudeConfigDir?: string;
	galleryId?: string;
	memberType?: 'teammate' | 'pm';
	displayName?: string;
	canStopResting?: boolean;
	name: string;
	provider: string;
	cwd: string;
	expertise: string;
	domain: string;
	/** The registered teammate covering this one's domain, by display name; '' for none. */
	backup: string;
	notes: string;
	notesRevision: string | null;
	/** profileTextRevision of the expertise and domain this form loaded; null while adding. */
	profileRevision: string | null;
	/** Saved model, variant and LM Studio URL loaded by this form; null while adding. */
	kiloSettingsRevision?: string | null;
	sessionId: string;
	model?: string;
	/** Kilo only: registered reasoning variant for each launch's startup turn, if the model lists it. */
	variant?: string;
	lmStudioUrl?: string;
}
