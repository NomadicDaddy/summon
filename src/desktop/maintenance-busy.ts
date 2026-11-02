/**
 * Whether the Team Maintenance dialog is running an action, and the one owner of what that turns
 * off: the teammate select, the Team settings controls and Save. Save is also off while there is
 * no CLI to save a new teammate with. Nothing else turns Save back on.
 *
 * Save used to stay enabled while another dialog action ran (a profile loading, Team settings
 * applying, usage refreshing), and run() dropped the submit without a word: the form kept the
 * model just typed, nothing was saved, and nothing said so (kilo-model-selection-persistence,
 * 2026-10-24). Disabled, the button shows the wait, and Enter in a field cannot submit either,
 * because implicit submission does nothing while the form's default button is disabled.
 *
 * savingProfile still marks its own save in flight. It restores the state it found, which while a
 * save runs is always this busy state, so it cannot re-enable Save early.
 */
export function maintenanceBusy(
	save: HTMLButtonElement,
	select: HTMLSelectElement,
	teamSettings: { setBusy: (busy: boolean) => void },
): {
	active: () => boolean;
	set: (busy: boolean) => void;
	setRunnable: (runnable: boolean) => void;
} {
	let busy = false;
	let runnable = true;
	const apply = (): void => {
		save.disabled = busy || !runnable;
	};
	return {
		active: () => busy,
		set: (value) => {
			busy = value;
			select.disabled = value;
			teamSettings.setBusy(value);
			apply();
		},
		setRunnable: (value) => {
			runnable = value;
			apply();
		},
	};
}
