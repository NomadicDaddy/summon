import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

import type { TeamSnapshot } from './types.ts';

import { faultText, reportFault } from './fault-report.ts';
import { readableError } from './ipc-error.ts';
import { createThemedTerminal } from './terminal-style.ts';

export function setupOperator(windowsPty: TeamSnapshot['windowsPty']): void {
	function element(id: string): HTMLElement {
		const node = document.getElementById(id);
		if (!node) throw new Error(`Missing ${id}`);
		return node;
	}
	const panel = element('operator');
	const area = element('operator-terminal');
	const start = element('operator-start') as HTMLButtonElement;
	const stop = element('operator-stop') as HTMLButtonElement;
	const copy = element('operator-copy') as HTMLButtonElement;
	const select = element('operator-shell') as HTMLSelectElement;
	const status = element('operator-status');
	let running = false;
	let busy = false;
	let terminal: Terminal | undefined;
	let fit: FitAddon | undefined;
	let previousFocus: HTMLElement | null = null;
	function copySelection(): void {
		const text = terminal?.getSelection();
		if (!text) return;
		void window.team.operatorCopy(text).catch((error: unknown) => {
			status.textContent = `Copy failed: ${readableError(error)}`;
			reportFault({ level: 'error', source: 'operator.copy', text: faultText(error) });
		});
	}
	copy.addEventListener('click', copySelection);
	function fitPane(): void {
		if (panel.hidden || !terminal) return;
		fit?.fit();
		window.team.operatorResize(terminal.cols, terminal.rows);
	}
	function controls(): void {
		select.disabled = running || busy;
		start.disabled = running || busy || !select.value;
		stop.disabled = !running || busy;
	}
	function createTerminal(): Terminal {
		terminal?.dispose();
		area.replaceChildren();
		terminal = createThemedTerminal({
			...(windowsPty ? { windowsPty } : {}),
			scrollback: 3000,
		});
		fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.open(area);
		copy.disabled = true;
		terminal.onSelectionChange(() => {
			copy.disabled = !terminal?.hasSelection();
		});
		terminal.attachCustomKeyEventHandler((event) => {
			if (
				(event.ctrlKey || event.metaKey) &&
				!event.altKey &&
				event.key.toLowerCase() === 'c' &&
				(terminal?.hasSelection() || event.shiftKey)
			) {
				if (event.type === 'keydown') copySelection();
				event.preventDefault();
				return false;
			}
			return true;
		});
		terminal.onData((data) => window.team.operatorInput(data));
		terminal.onResize(({ cols, rows }) => window.team.operatorResize(cols, rows));
		fitPane();
		return terminal;
	}
	async function launch(): Promise<void> {
		if (busy || running || !select.value) return;
		busy = true;
		controls();
		try {
			const term = createTerminal();
			await window.team.operatorStart(select.value, term.cols, term.rows);
			localStorage.setItem('operator-shell', select.value);
			term.focus();
		} catch (error: unknown) {
			status.textContent = readableError(error);
			reportFault({ level: 'error', source: 'operator.start', text: faultText(error) });
		} finally {
			busy = false;
			controls();
		}
	}
	function setOpen(open: boolean): void {
		if (open)
			previousFocus =
				document.activeElement instanceof HTMLElement ? document.activeElement : null;
		panel.hidden = !open;
		document.body.classList.toggle('operator-open', open);
		if (open)
			requestAnimationFrame(() => {
				fitPane();
				if (!terminal) void launch();
				else terminal.focus();
			});
		else (previousFocus?.isConnected ? previousFocus : element('room-toggle')).focus();
	}
	function shortcut(event: KeyboardEvent): boolean {
		if (!event.ctrlKey || event.altKey || event.shiftKey || event.code !== 'Backquote')
			return false;
		event.preventDefault();
		event.stopPropagation();
		if (!event.repeat) setOpen(Boolean(panel.hidden));
		return true;
	}
	document.addEventListener(
		'keydown',
		(event) => {
			shortcut(event);
		},
		true,
	);
	element('operator-hide').addEventListener('click', () => setOpen(false));
	start.addEventListener('click', () => {
		void launch();
	});
	select.addEventListener('change', controls);
	stop.addEventListener('click', () => {
		// Stop ends the shell and anything running in it, so it asks, as Stop Session does. Hide keeps
		// the session and does not.
		if (!window.confirm('Stop the operator shell? Anything running in it will be terminated.'))
			return;
		busy = true;
		controls();
		void window.team
			.operatorStop()
			.catch((error: unknown) => {
				status.textContent = readableError(error);
				reportFault({ level: 'error', source: 'operator.stop', text: faultText(error) });
			})
			.finally(() => {
				busy = false;
				controls();
			});
	});
	window.team.onOperatorEvent((event) => {
		if (event.type === 'output') terminal?.write(event.data);
		else if (event.type === 'started') {
			running = true;
			status.textContent = event.cwd;
		} else {
			running = false;
			status.textContent = `Session ended (${event.exitCode})`;
			terminal?.write(`\r\n[Session ended: ${event.exitCode}]\r\n`);
		}
		controls();
	});
	new ResizeObserver(fitPane).observe(area);
	window.team.onImagePaste(() => {
		if (area.contains(document.activeElement)) window.team.operatorInput('\x16');
	});
	void window.team
		.shells()
		.then((shells) => {
			for (const shell of shells) select.add(new Option(shell.label, shell.id));
			const saved = localStorage.getItem('operator-shell');
			if (saved && shells.some((shell) => shell.id === saved)) select.value = saved;
			status.textContent = shells.length ? 'Ready' : 'No supported shell found';
			controls();
		})
		.catch((error: unknown) => {
			status.textContent = readableError(error);
			reportFault({ level: 'error', source: 'operator.shells', text: faultText(error) });
		});
}
