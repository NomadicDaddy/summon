import { afterEach, describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';

import { readColorTheme } from '../src/desktop/color-theme.ts';
import { themeBlock as block, contrast } from './fixtures/theme-colors.ts';

/*
 * The Team Window's light and dark themes (card cca8d66e). Every colour lives in theme.css, so a
 * theme is a set of token values; these tests keep it that way, keep the two themes in step, and
 * hold the light theme's main text pairs at AA.
 */
const desktop = 'src/desktop';
const read = (name: string): Promise<string> => Bun.file(`${desktop}/${name}`).text();
const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('every colour is a theme token', () => {
	test('no stylesheet but theme.css carries a colour literal in its declarations', async () => {
		const sheets = (await readdir(desktop)).filter(
			(f) => f.endsWith('.css') && f !== 'theme.css',
		);
		const found: string[] = [];
		for (const name of sheets) {
			for (const m of withoutComments(await read(name)).matchAll(/:\s*([^;{}]+);/g)) {
				for (const c of m[1]?.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? [])
					found.push(`${name}: ${c}`);
			}
		}
		expect(found).toEqual([]);
	});

	test('every token a stylesheet uses is defined, and both themes define the same set', async () => {
		const theme = await read('theme.css');
		const dark = block(theme, ':root');
		const light = block(theme, ":root[data-theme='light']");
		expect([...light.keys()].sort()).toEqual([...dark.keys()].sort());
		const sheets = (await readdir(desktop)).filter(
			(f) => f.endsWith('.css') && f !== 'theme.css',
		);
		const used = new Set<string>();
		for (const name of sheets)
			for (const m of (await read(name)).matchAll(/var\((--[a-z0-9-]+)\)/g))
				used.add(m[1] as string);
		expect([...used].filter((token) => !dark.has(token))).toEqual([]);
	});
});

describe('the light theme stays readable', () => {
	test('its main text pairs reach AA on the surfaces they sit on', async () => {
		const light = block(await read('theme.css'), ":root[data-theme='light']");
		const pairs: [string, string][] = [
			['--text', '--bg-app'],
			['--text', '--bg-panel'],
			['--text-2', '--bg-raised'],
			['--muted', '--bg-app'],
			['--muted', '--bg-panel'],
			['--muted-7', '--bg-app'],
			['--accent', '--bg-app'],
			['--accent', '--bg-panel'],
			['--accent', '--bg-hover'],
			['--accent', '--accent-bg'],
			['--on-accent', '--accent'],
			['--accent-text', '--accent-bg'],
			['--warn', '--warn-bg'],
			['--danger', '--danger-bg'],
			['--info', '--info-bg'],
			['--brand', '--bg-panel'],
		];
		const failing = pairs
			.map(
				([fg, bg]) => [fg, bg, contrast(light.get(fg) ?? '', light.get(bg) ?? '')] as const,
			)
			.filter(([, , ratio]) => ratio < 4.5)
			.map(([fg, bg, ratio]) => `${fg} on ${bg}: ${ratio.toFixed(2)}`);
		expect(failing).toEqual([]);
	});
});

describe('the stored choice', () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
	afterEach(() => {
		if (original) Object.defineProperty(globalThis, 'localStorage', original);
		else Reflect.deleteProperty(globalThis, 'localStorage');
	});
	const storing = (getItem: () => null | string): void => {
		Object.defineProperty(globalThis, 'localStorage', {
			configurable: true,
			value: { getItem },
		});
	};

	test('only the exact value light is light; anything else, or unreadable storage, is dark', () => {
		storing(() => 'light');
		expect(readColorTheme()).toBe('light');
		for (const value of [null, 'dark', 'Light', 'blue', '']) {
			storing(() => value);
			expect(readColorTheme()).toBe('dark');
		}
		storing(() => {
			throw new Error('storage unavailable');
		});
		expect(readColorTheme()).toBe('dark');
	});

	test('the page applies it before any stylesheet, and the tokens before the styles', async () => {
		const html = await read('index.html');
		const boot = html.indexOf('<script src="theme-boot.js"></script>');
		expect(boot).toBeGreaterThan(0);
		expect(boot).toBeLessThan(html.indexOf('rel="stylesheet"'));
		expect(html.indexOf('href="theme.css"')).toBeLessThan(html.indexOf('href="style.css"'));
	});
});
