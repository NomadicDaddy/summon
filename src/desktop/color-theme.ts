/**
 * The window's colour theme: dark (the default) or light (card cca8d66e, Phillip #6430/#6431).
 *
 * A window preference rather than team data, so it lives in localStorage beside
 * summon.showDomainCoverage and survives nothing but this browser profile. Only the two exact values
 * mean anything; a missing, unreadable or unknown value is dark, which is the window as it always
 * looked. The theme is the data-theme attribute on <html>, which theme.css keys its light values on.
 */
export type ColorTheme = 'dark' | 'light';

const storageKey = 'summon.colorTheme';

export function readColorTheme(): ColorTheme {
	try {
		return localStorage.getItem(storageKey) === 'light' ? 'light' : 'dark';
	} catch {
		return 'dark';
	}
}

/** Returns false when the choice applied but could not be stored for the next start. */
export function saveColorTheme(theme: ColorTheme): boolean {
	try {
		localStorage.setItem(storageKey, theme);
		return true;
	} catch {
		return false;
	}
}

export function applyColorTheme(theme: ColorTheme): void {
	document.documentElement.dataset.theme = theme;
}

export function currentColorTheme(): ColorTheme {
	return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}
