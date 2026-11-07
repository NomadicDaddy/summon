/**
 * The self-contained controls that were sitting inside the maintenance dialog's one closure.
 *
 * Neither belongs to the profile form they were nested in: a view preference for the sidebar, a usage
 * reading, the removal, the team switches. They were there because the closure was where
 * everything went - setupMaintenance mixed unrelated controls with profile editing and dialog
 * coordination. This split gives those controls a separate responsibility.
 */

import { applyColorTheme, readColorTheme, saveColorTheme } from './color-theme.ts';
import { reportFault } from './fault-report.ts';
import { rethemeTerminals } from './terminal-style.ts';

/** The profile form's fields, by the suffix of their `maint-` element id. */
export const profileFields = [
	'name',
	'provider',
	'cwd',
	'expertise',
	'domain',
	'backup',
	'notes',
	'sessionId',
	'model',
	'variant',
	'lmStudioUrl',
	'claudeConfigDir',
] as const;

/**
 * The window's own preferences: whether the sidebar shows domain coverage, who is furthest behind
 * the room and delivery alerts (#12987), and the colour theme (card cca8d66e).
 *
 * Window preferences rather than team data, so they live in localStorage and survive nothing but
 * this browser profile. Every read and write is guarded: storage throws in some contexts, and a
 * preference is worth less than the dialog it would take down.
 */
export function setupWindowPreferences(get: (id: string) => HTMLElement, error: HTMLElement): void {
	const lightTheme = get('maint-light-theme') as HTMLInputElement;
	lightTheme.checked = readColorTheme() === 'light';
	lightTheme.addEventListener('change', () => {
		const theme = lightTheme.checked ? 'light' : 'dark';
		applyColorTheme(theme);
		rethemeTerminals();
		if (!saveColorTheme(theme)) {
			error.textContent = 'The theme changed for this window but could not be saved.';
			reportFault({ level: 'error', source: 'maintenance.theme', text: error.textContent });
		}
	});
	const coverage = get('roster-coverage');
	sidebarSwitch(get('maint-show-coverage') as HTMLInputElement, error, {
		apply: (shown) => {
			coverage.hidden = !shown;
		},
		key: 'summon.showDomainCoverage',
		name: 'Coverage visibility',
		source: 'maintenance.coverage',
	});
	// The two amber sidebar lines, each switchable on its own (Phillip #12987).
	const progress = get('roster-progress');
	sidebarSwitch(get('maint-show-progress') as HTMLInputElement, error, {
		apply: (shown) => {
			progress.hidden = !shown;
		},
		key: 'summon.showRoomProgress',
		name: 'Furthest-behind visibility',
		source: 'maintenance.progress',
	});
	sidebarSwitch(get('maint-show-delivery') as HTMLInputElement, error, {
		/*
		 * The delivery section shows and hides itself as alerts come and go, so this switch does not
		 * touch its `hidden`. It marks the body instead, and response-watchdog.css keeps the section
		 * and the sidebar layout it would change out of view while the mark is set.
		 */
		apply: (shown) => {
			if (shown) delete document.body.dataset['deliveryAlerts'];
			else document.body.dataset['deliveryAlerts'] = 'off';
		},
		key: 'summon.showDeliveryAlerts',
		name: 'Delivery alert visibility',
		source: 'maintenance.delivery',
	});
}

/** One "Show … in the sidebar" checkbox: on by default, applied at once, kept per window. */
function sidebarSwitch(
	input: HTMLInputElement,
	error: HTMLElement,
	options: { apply: (shown: boolean) => void; key: string; name: string; source: string },
): void {
	try {
		input.checked = localStorage.getItem(options.key) !== 'false';
	} catch {
		// Keep the default visible when local preferences cannot be read.
	}
	options.apply(input.checked);
	input.addEventListener('change', () => {
		options.apply(input.checked);
		try {
			localStorage.setItem(options.key, String(input.checked));
		} catch {
			error.textContent = `${options.name} changed for this window but could not be saved.`;
			reportFault({ level: 'error', source: options.source, text: error.textContent });
		}
	});
}

/**
 * Reading a teammate's provider usage.
 *
 * Its own control rather than part of the form: nothing here edits a profile, and the reading is
 * about the account behind the teammate rather than the record in front of you.
 */
export function setupUsageReport(
	get: (id: string) => HTMLElement,
	run: (work: () => Promise<void>) => void,
	current: () => null | string,
): void {
	get('maint-usage-refresh').addEventListener('click', () => {
		run(async () => {
			const existing = current();
			if (!existing) throw new Error('Choose a registered teammate first.');
			get('maint-usage').textContent = 'Reading provider usage…';
			const report = await window.team.usage(existing);
			get('maint-usage').textContent =
				`${report.lines.join('\n')}\nChecked ${new Date(report.checkedAt).toLocaleString()}`;
		});
	});
}

/**
 * Removing a teammate, behind the typed confirmation.
 *
 * The caller is told what happened and decides what its own state becomes - this owns the rule for
 * whether a removal may proceed and nothing about what the dialog looks like afterwards. The
 * confirmation compares against the slug rather than the display name because the slug is what the
 * removal acts on, and a near-miss here deletes the wrong teammate's files.
 */
export function setupRemoval(
	get: (id: string) => HTMLElement,
	run: (work: () => Promise<void>) => void,
	current: () => null | string,
	removed: (archive: boolean) => Promise<void>,
): void {
	get('maint-remove').addEventListener('click', () => {
		run(async () => {
			const existing = current();
			if (!existing) return;
			if ((get('maint-confirm') as HTMLInputElement).value.trim().toLowerCase() !== existing)
				throw new Error(`Type ${existing} to confirm removal.`);
			const archive = (get('maint-mode') as HTMLSelectElement).value === 'archive';
			await window.team.removeProfile(existing, archive);
			await removed(archive);
		});
	});
}

/**
 * The two team-wide switches: whether mentions wake a stopped teammate, and whether Claude stops to
 * confirm its development channel at every start.
 *
 * They live here for the reason this file exists at all - setupMaintenance was already at its line
 * limit when the second one arrived, and the comment at the top of this module records that the
 * previous several commits to that file each made it longer. Grouping them also fixes something
 * real rather than only moving lines: both now load from ONE read of the settings object, where
 * before each read it separately, which is exactly how a dialog ends up showing one of two settings
 * stale.
 *
 * Checked means live, and neither mode name reaches the interface. The operator is deciding whether
 * Claude prompts; `live` and `checkpoint` are what the setting is called underneath.
 */
export function setupTeamSettings(
	get: (id: string) => HTMLElement,
	run: (work: () => Promise<void>) => void,
): { apply: () => Promise<void>; setBusy: (busy: boolean) => void } {
	const wakeMentions = get('maint-wake-mentions') as HTMLInputElement;
	const claudeLive = get('maint-claude-live') as HTMLInputElement;
	const autoHold = get('maint-auto-hold') as HTMLInputElement;
	const autoHeadDown = get('maint-auto-head-down') as HTMLInputElement;
	const holdSeconds = get('maint-hold-seconds') as HTMLInputElement;
	// A refused save puts the box back, so the dialog never shows a state the file does not hold.
	const bind = (box: HTMLInputElement, change: (checked: boolean) => Promise<unknown>): void => {
		box.addEventListener('change', () => {
			const requested = box.checked;
			run(async () => {
				try {
					await change(requested);
				} catch (error: unknown) {
					box.checked = !requested;
					throw error;
				}
			});
		});
	};
	bind(wakeMentions, (wakeOnMention) => window.team.saveSettings({ wakeOnMention }));
	bind(claudeLive, (live) =>
		window.team.saveSettings({ claudeDelivery: live ? 'live' : 'checkpoint' }),
	);
	bind(autoHold, (hold) => window.team.saveSettings({ autoHold: hold }));
	bind(autoHeadDown, (enabled) => window.team.saveSettings({ autoHeadDown: enabled }));
	// The seconds field saves on change; a refused value (blank, fraction, out of range) goes
	// back to the saved one, so the dialog never shows a countdown the file does not hold.
	let savedSeconds = holdSeconds.value;
	holdSeconds.addEventListener('change', () => {
		const requested = holdSeconds.value.trim();
		run(async () => {
			try {
				const settings = await window.team.saveSettings({ holdSeconds: Number(requested) });
				savedSeconds = String(settings.holdSeconds);
				holdSeconds.value = savedSeconds;
			} catch (error: unknown) {
				holdSeconds.value = savedSeconds;
				throw error;
			}
		});
	});
	return {
		apply: async (): Promise<void> => {
			const settings = await window.team.settings();
			wakeMentions.checked = settings.wakeOnMention;
			claudeLive.checked = settings.claudeDelivery === 'live';
			autoHold.checked = settings.autoHold;
			autoHeadDown.checked = settings.autoHeadDown;
			savedSeconds = String(settings.holdSeconds);
			holdSeconds.value = savedSeconds;
		},
		setBusy: (busy: boolean): void => {
			wakeMentions.disabled = busy;
			claudeLive.disabled = busy;
			autoHold.disabled = busy;
			autoHeadDown.disabled = busy;
			holdSeconds.disabled = busy;
		},
	};
}
