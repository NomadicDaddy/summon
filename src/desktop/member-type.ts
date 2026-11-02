import type { TeamProfile } from '../team-maintenance.ts';

/**
 * What kind of member this is, and the two things that answer differently because of it.
 *
 * A PM is not a teammate with a different job title. It has no domain and no expertise - Summon
 * supplies both - so the form asks for neither, and it carries a DISPLAY NAME that the operator can
 * change, which a teammate does not.
 *
 * WHY A SEPARATE NAME AT ALL. The registered name is the slug: the mailbox directory, the Board's
 * actor, the session record, every room reference that has ever named it. Renaming that would move
 * mail and orphan history. So the registration name is fixed at creation and the display name is
 * the one the roster shows - a rename that costs nothing because nothing is keyed on it.
 *
 * BUT ONLY ONE NAME WHILE CREATING (#5592). The two can only differ after creation, so asking for
 * both up front showed the same word twice under two labels and asked the operator to work out the
 * difference before there was one. A new PM is named once, the display name starts as that name,
 * and the separate field appears when editing an existing PM, where a rename is what it is for.
 *
 * MEMBER TYPE IS A CREATION DECISION. Changing it later would change which fields mean anything on
 * a record that already has them filled in, so the control is offered while adding and read-only
 * afterwards. Morgan's backend refuses the change independently; this is the form agreeing with it
 * rather than relying on it.
 */
export interface MemberTypeView {
	/** What the form should submit, including the empty strings a PM supplies for Summon to fill. */
	apply: (profile: TeamProfile) => TeamProfile;
	/**
	 * Show the controls for an existing member, or for a new one.
	 *
	 * `live` is whether that member has a session running, which decides whether its CLI can be
	 * changed. Passed in rather than read here because the status belongs to the roster snapshot.
	 */
	fill: (profile: TeamProfile | null, live?: boolean) => void;
}

export const PM_DEFAULT_NAME = 'Steward';

export function setupMemberType(
	get: (id: string) => HTMLElement,
	onChange: () => void,
): MemberTypeView {
	const type = get('maint-member-type') as HTMLSelectElement;
	const typeRow = get('maint-member-type-row');
	const displayRow = get('maint-display-name-row');
	const display = get('maint-display-name') as HTMLInputElement;
	const canStop = get('maint-can-stop-resting') as HTMLInputElement;
	const provider = get('maint-provider') as HTMLSelectElement;
	const name = get('maint-name') as HTMLInputElement;

	const isPm = (): boolean => type.value === 'pm';
	let creating = true;

	/* Expertise and domain are not hidden to tidy the form: a PM has neither, and asking for them
	   would invite the operator to write something Summon is about to overwrite. */
	const paint = (): void => {
		const pm = isPm();
		displayRow.hidden = !pm || creating;
		for (const id of ['maint-expertise-row', 'maint-domain-row']) get(id).hidden = pm;
		onChange();
	};

	type.addEventListener('change', () => {
		/*
		 * The name defaults, and only while untouched so an operator who typed one keeps it.
		 *
		 * It is the slug, it cannot change afterwards, and a PM created with a blank one would be named
		 * after whatever the operator happened to type. Defaulting it means the create button works
		 * the moment the type is chosen, and it remains editable until it is pressed. The display name
		 * is taken from it at creation, so there is no second field to default.
		 */
		if (isPm() && !name.disabled && name.value.trim() === '') name.value = PM_DEFAULT_NAME;
		paint();
	});

	return {
		apply: (profile) => {
			const pm = isPm();
			return {
				...profile,
				...(pm ? { expertise: '', domain: '' } : {}),
				memberType: pm ? 'pm' : 'teammate',
				// A new PM is shown by the one name it was given; only an edit has a separate field.
				...(pm
					? {
							displayName:
								(creating ? name.value : display.value).trim() || PM_DEFAULT_NAME,
						}
					: {}),
				canStopResting: canStop.checked,
			};
		},
		fill: (profile, live = false) => {
			creating = profile === null;
			type.value = profile?.memberType ?? 'teammate';
			display.value = profile?.displayName ?? (type.value === 'pm' ? PM_DEFAULT_NAME : '');
			canStop.checked = profile?.canStopResting ?? false;
			// The choice itself is creation-only; the row stays visible so an existing PM still says
			// what it is rather than leaving the operator to infer it from the missing fields.
			type.disabled = profile !== null;
			typeRow.hidden = false;
			/*
			 * Who may change the CLI, decided in one place.
			 *
			 * A teammate's CLI is fixed once registered, because its provider conversation is bound
			 * to it. A PM may move while it is stopped: the backend clears the old binding and
			 * refuses the change on a live session, and this agrees with it rather than leaving the
			 * operator to submit something that will be rejected.
			 *
			 * maintenance.ts used to set this too. Two owners for one control is what made the home
			 * page go blank on beazley.org this afternoon, so there is one here.
			 */
			const pmMayMove = profile?.memberType === 'pm' && !live;
			provider.disabled = profile !== null && !pmMayMove;
			paint();
		},
	};
}
