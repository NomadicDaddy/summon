import { type ITerminalOptions, type ITheme, Terminal } from '@xterm/xterm';

import { currentColorTheme } from './color-theme.ts';

const terminalStyle = {
	fontFamily: 'Cascadia Code, Consolas, monospace',
	fontSize: 14,
	cursorBlink: true,
} satisfies ITerminalOptions;

/** The dark terminal is exactly what it was before themes existed; xterm's default ANSI colours. */
const darkTerminal: ITheme = { background: '#101518', foreground: '#dce4e4', cursor: '#87d6b2' };

/*
 * The light terminal sits on the light window's surface, and replaces the ANSI colours too: xterm's
 * defaults are tuned for a dark background, where bright yellow and cyan are readable and on an
 * off-white they disappear. Each colour here reads at 4.5:1 or better on the background.
 */
const lightTerminal: ITheme = {
	background: '#f3f0ea',
	foreground: '#1d2527',
	cursor: '#2b7a5a',
	cursorAccent: '#f3f0ea',
	selectionBackground: '#cfe6da',
	black: '#1d2527',
	red: '#a8322a',
	green: '#2b6e3f',
	yellow: '#7a5a0e',
	blue: '#2e5596',
	magenta: '#7d3f8c',
	cyan: '#1f6b73',
	white: '#5c6466',
	brightBlack: '#4f5759',
	brightRed: '#8f2a23',
	brightGreen: '#235a33',
	brightYellow: '#664b0b',
	brightBlue: '#24467d',
	brightMagenta: '#673374',
	brightCyan: '#18565c',
	brightWhite: '#3a4244',
};

function terminalTheme(): ITheme {
	return currentColorTheme() === 'light' ? lightTerminal : darkTerminal;
}

const themedTerminals = new Set<WeakRef<Terminal>>();

/** A terminal in the window's style and current colours, recoloured when the theme changes. */
export function createThemedTerminal(options: ITerminalOptions): Terminal {
	const terminal = new Terminal({ ...terminalStyle, theme: terminalTheme(), ...options });
	themedTerminals.add(new WeakRef(terminal));
	return terminal;
}

export function rethemeTerminals(): void {
	for (const ref of themedTerminals) {
		const terminal = ref.deref();
		if (!terminal) {
			themedTerminals.delete(ref);
			continue;
		}
		try {
			terminal.options.theme = terminalTheme();
		} catch {
			// A disposed terminal: nothing left to recolour.
			themedTerminals.delete(ref);
		}
	}
}
