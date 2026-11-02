import { expect, test } from 'bun:test';

import { roomNames } from '../src/desktop/room-names.ts';
import { editorDom, EditorElement } from './fixtures/editor-dom.ts';
import { contrast, themeBlock } from './fixtures/theme-colors.ts';

const read = (file: string): Promise<string> => Bun.file(`src/desktop/${file}`).text();
const roomBackgrounds = ['--bg-panel', '--info-bg', '--warn-bg-2', '--warn-bg-3'];

test('primary interaction pairs and all Room identity colors pass AA in both themes', async () => {
	const css = await read('theme.css');
	for (const selector of [':root', ":root[data-theme='light']"]) {
		const values = themeBlock(css, selector);
		const color = (token: string): string => values.get(token) ?? '';
		expect(contrast(color('--on-accent'), color('--accent'))).toBeGreaterThanOrEqual(4.5);
		expect(
			contrast(color('--primary-hover-text'), color('--primary-hover')),
		).toBeGreaterThanOrEqual(4.5);
		const palette = Array.from({ length: 16 }, (_, index) => color(`--room-name-${index}`));
		expect(new Set(palette).size).toBe(16);
		for (const foreground of palette)
			for (const background of roomBackgrounds)
				expect(contrast(foreground, color(background))).toBeGreaterThanOrEqual(4.5);
		for (const foreground of ['--text', '--accent', '--warn', '--muted', '--text-2'])
			expect(contrast(color(foreground), color('--bg-panel'))).toBeGreaterThanOrEqual(4.5);
	}
	const style = await read('style.css');
	expect(style).toMatch(
		/\.primary:hover,\s*\.primary:focus-visible\s*\{[^}]*var\(--primary-hover\)[^}]*var\(--primary-hover-text\)/u,
	);
});

test('actual sender and mention renderers retain stable, theme-resolved identities and safe text', () => {
	const dom = editorDom();
	try {
		const agents = Array.from({ length: 20 }, (_, i) => ({
			slug: `fixture-${i}`,
			name: `Palette${i}`,
		}));
		const names = roomNames(agents, {
			display: 'Human',
			aliases: [],
			mentionOnly: ['operator'],
			recipientAliases: [],
		});
		const colors = new Set<string>();
		for (const agent of agents) {
			const sender = new EditorElement('strong');
			names.sender(sender as unknown as HTMLElement, agent.slug, false);
			const upper = new EditorElement('strong');
			names.sender(upper as unknown as HTMLElement, agent.slug.toUpperCase(), false);
			expect(upper.style.color).toBe(sender.style.color);
			expect(sender.style.color).toMatch(/^var\(--room-name-\d+\)$/u);
			colors.add(sender.style.color);
			const line = new EditorElement('p');
			names.text(line as unknown as HTMLElement, `prefix @${agent.slug} <script> literal`);
			expect(line.querySelector('strong')?.style.color).toBe(sender.style.color);
			expect(line.querySelector('script')).toBeNull();
			expect(line.children.at(-1)?.textContent).toBe(' <script> literal');
		}
		expect(colors.size).toBe(16);
		const human = new EditorElement('strong');
		names.sender(human as unknown as HTMLElement, 'operator', true);
		expect(human.className).toBe('room-name room-name-human');
		expect(human.style.color).toBe('');
		const line = new EditorElement('p');
		names.text(line as unknown as HTMLElement, '@operator @all');
		expect(line.querySelectorAll('strong').map((node) => node.className)).toEqual([
			'room-name room-name-human',
			'room-name room-name-all',
		]);
	} finally {
		dom.restore();
	}
});

test('stale schedules and readable resting-row text never inherit a fading treatment', async () => {
	const stale = (await read('schedule-view.css')).match(
		/\.schedule-body\.is-stale\s*\{([^}]*)\}/u,
	)?.[1];
	expect(stale).toBeDefined();
	expect(stale).not.toMatch(/opacity|filter/u);
	expect(stale).toContain('var(--warn-line)');
	const rest = await read('rest.css');
	const fadedSelectors = [...rest.matchAll(/([^{}]+)\{[^}]*opacity:\s*0\.55[^}]*\}/gu)].map(
		(match) => match[1]?.trim(),
	);
	expect(fadedSelectors).toEqual(['.rest-row .avatar img']);
});
