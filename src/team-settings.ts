import { claudeDelivery, type ClaudeDelivery, setClaudeDelivery } from './claude-delivery.ts';
import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import { teamWindowRuntime } from './team-startup.ts';

export interface TeamSettings {
	/** Held in its own file, because a teammate's session reads it and this window's file is not its to read. */
	claudeDelivery: ClaudeDelivery;
	wakeOnMention: boolean;
	/**
	 * Whether selecting or typing at a running teammate holds automatic interruptions for a while
	 * (Phillip #7266). Off, only the pinned Hold button pauses anyone.
	 */
	autoHold: boolean;
	/** How long that automatic hold lasts, in whole seconds. */
	holdSeconds: number;
}

type WindowSettings = Pick<TeamSettings, 'autoHold' | 'holdSeconds' | 'wakeOnMention'>;

const HOLD_SECONDS_MIN = 5;
const HOLD_SECONDS_MAX = 600;
const WINDOW_DEFAULTS: WindowSettings = { autoHold: true, holdSeconds: 30, wakeOnMention: true };
const WINDOW_KEYS = Object.keys(WINDOW_DEFAULTS);

function settingsPath(): string {
	return teamWindowRuntime('settings.json');
}

/** The window file holds only the keys that were ever saved; the rest take their defaults on read. */
function validate(value: unknown): Partial<WindowSettings> {
	if (!value || typeof value !== 'object') throw new Error('Invalid team settings.');
	const settings = value as Record<string, unknown>;
	if (Object.keys(settings).some((key) => !WINDOW_KEYS.includes(key)))
		throw new Error('Invalid team settings.');
	const stored: Partial<WindowSettings> = {};
	if (settings.wakeOnMention !== undefined) {
		if (typeof settings.wakeOnMention !== 'boolean')
			throw new Error('Invalid mention setting.');
		stored.wakeOnMention = settings.wakeOnMention;
	}
	if (settings.autoHold !== undefined) {
		if (typeof settings.autoHold !== 'boolean') throw new Error('Invalid hold setting.');
		stored.autoHold = settings.autoHold;
	}
	if (settings.holdSeconds !== undefined) {
		const seconds = settings.holdSeconds;
		if (
			typeof seconds !== 'number' ||
			!Number.isInteger(seconds) ||
			seconds < HOLD_SECONDS_MIN ||
			seconds > HOLD_SECONDS_MAX
		)
			throw new Error(
				`Hold countdown must be a whole number of seconds from ${HOLD_SECONDS_MIN} to ${HOLD_SECONDS_MAX}.`,
			);
		stored.holdSeconds = seconds;
	}
	return stored;
}

async function readWindowSettings(): Promise<Partial<WindowSettings>> {
	const text = await optionalText(settingsPath());
	return text === undefined ? {} : validate(JSON.parse(text));
}

export async function readTeamSettings(): Promise<TeamSettings> {
	operatorOnly();
	return {
		...WINDOW_DEFAULTS,
		...(await readWindowSettings()),
		claudeDelivery: await claudeDelivery(),
	};
}

/** Applies the settings named in `value` and leaves the rest as they are. */
export async function saveTeamSettings(value: unknown): Promise<TeamSettings> {
	operatorOnly();
	if (!value || typeof value !== 'object') throw new Error('Invalid team settings.');
	const { claudeDelivery: delivery, ...window } = value as Record<string, unknown>;
	if (delivery === undefined && Object.keys(window).length === 0)
		throw new Error('Invalid team settings.');
	// Both parts are checked before either is written, so a refused change alters nothing.
	const changed = Object.keys(window).length === 0 ? undefined : validate(window);
	if (delivery !== undefined && delivery !== 'checkpoint' && delivery !== 'live')
		throw new Error('Invalid Claude delivery mode.');
	// Merged under the store's lock, so two controls saving at once keep each other's keys.
	if (changed)
		await locked(`${settingsPath()}.lock`, async () => {
			const stored = { ...(await readWindowSettings()), ...changed };
			await atomicWrite(settingsPath(), JSON.stringify(stored));
		});
	if (delivery !== undefined) await setClaudeDelivery(delivery);
	return readTeamSettings();
}
