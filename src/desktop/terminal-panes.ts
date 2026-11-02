import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

import type { TeamSnapshot } from './types.ts';

import { bindTerminalInput } from './terminal-input-origin.ts';
import { createThemedTerminal } from './terminal-style.ts';

export interface TerminalPane {
	fit: FitAddon;
	node: HTMLDivElement;
	terminal: Terminal;
}

export interface TerminalPanes {
	fitSelected: () => void;
	get: (slug: string) => TerminalPane | undefined;
	has: (slug: string) => boolean;
	open: (slug: string) => TerminalPane;
	reset: (slug: string) => void;
	sync: (value: TeamSnapshot) => void;
}

/** One xterm pane per running teammate, shown only for the selected one and fitted to the area. */
export function setupTerminalPanes(area: HTMLElement, current: () => TeamSnapshot): TerminalPanes {
	const panes = new Map<string, TerminalPane>();
	function open(slug: string): TerminalPane {
		const existing = panes.get(slug);
		if (existing) return existing;
		const snapshot = current();
		const node = document.createElement('div');
		node.className = 'terminal-pane';
		node.hidden = snapshot.selected !== slug;
		area.append(node);
		const terminal = createThemedTerminal({
			...(snapshot.windowsPty ? { windowsPty: snapshot.windowsPty } : {}),
			scrollback: 2000,
		});
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.open(node);
		bindTerminalInput(terminal, (data, humanInput) =>
			window.team.input(slug, data, humanInput),
		);
		terminal.onResize(({ cols, rows }) => window.team.resize(slug, cols, rows));
		const value = { terminal, fit, node };
		panes.set(slug, value);
		return value;
	}
	function fitSelected(): void {
		const { selected } = current();
		const pane = panes.get(selected);
		if (pane && !pane.node.hidden) {
			pane.fit.fit();
			window.team.resize(selected, pane.terminal.cols, pane.terminal.rows);
		}
	}
	new ResizeObserver(fitSelected).observe(area);
	return {
		fitSelected,
		get: (slug) => panes.get(slug),
		has: (slug) => panes.has(slug),
		open,
		reset(slug) {
			const previous = panes.get(slug);
			previous?.terminal.dispose();
			previous?.node.remove();
			panes.delete(slug);
			open(slug);
			requestAnimationFrame(fitSelected);
		},
		sync(value) {
			for (const [slug, pane] of panes) {
				pane.node.hidden = slug !== value.selected;
				pane.terminal.options.disableStdin =
					value.agents.find((agent) => agent.slug === slug)?.status === 'hibernated';
			}
		},
	};
}
