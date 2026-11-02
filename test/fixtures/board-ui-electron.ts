import { app, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/*
 * Loads a Board renderer fixture at each requested content size, Room closed or open, and prints
 * what it measured. The fixture reports through document.title: `<marker> <json>` when done, and
 * `<marker>_KEY <n>` when it wants Enter pressed on its focused element, as a real key, once per n,
 * and `<marker>_FOCUS <n>` when it wants `[data-board-focus-probe]` forced into keyboard focus.
 */
const [root, marker, rawCases] = process.argv.slice(2);
if (!root || !marker || !rawCases) throw new Error('Usage: <fixture root> <marker> <cases json>');
const cases = JSON.parse(rawCases) as { height: number; room: boolean; width: number }[];
app.setPath('userData', join(root, 'electron-profile'));
app.disableHardwareAcceleration();

async function pressEnter(window: BrowserWindow): Promise<void> {
	// A button activates on Enter only from the full key sequence, as a keyboard would send it.
	window.webContents.sendInputEvent({ keyCode: 'Enter', type: 'keyDown' });
	window.webContents.sendInputEvent({ keyCode: '\r', type: 'char' });
	window.webContents.sendInputEvent({ keyCode: 'Enter', type: 'keyUp' });
	await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * Focusing an element in this hidden offscreen window was seen not to make it match
 * `:focus-visible`, probably because the window never holds OS focus. DevTools forces the
 * pseudo-classes on the probed element instead, and Chromium applies them to the cascade and the
 * paint. That simulates a keyboard focus; it is not one.
 */
async function forceKeyboardFocus(window: BrowserWindow): Promise<void> {
	const devtools = window.webContents.debugger;
	if (!devtools.isAttached()) devtools.attach('1.3');
	await devtools.sendCommand('DOM.enable');
	await devtools.sendCommand('CSS.enable');
	const { root } = (await devtools.sendCommand('DOM.getDocument')) as {
		root: { nodeId: number };
	};
	const { nodeId } = (await devtools.sendCommand('DOM.querySelector', {
		nodeId: root.nodeId,
		selector: '[data-board-focus-probe]',
	})) as { nodeId: number };
	await devtools.sendCommand('CSS.forcePseudoState', {
		forcedPseudoClasses: ['focus', 'focus-visible'],
		nodeId,
	});
}

async function innerSize(window: BrowserWindow): Promise<{ height: number; width: number }> {
	return (await window.webContents.executeJavaScript(
		'({ height: innerHeight, width: innerWidth })',
	)) as { height: number; width: number };
}

/**
 * Gives the page exactly the requested viewport. The content size Electron is asked for is not
 * always what the renderer gets: here it measured one pixel wider and taller, which hid a lane
 * wrap that the hosted runner's true viewport showed. So the size is read back from a blank page,
 * corrected once by the measured difference, and checked again; a case that still differs fails
 * rather than measuring at the wrong size.
 */
async function fitViewport(window: BrowserWindow, width: number, height: number): Promise<void> {
	window.setContentSize(width, height);
	await window.loadURL('about:blank');
	const first = await innerSize(window);
	if (first.width === width && first.height === height) return;
	window.setContentSize(width - (first.width - width), height - (first.height - height));
	await window.loadURL('about:blank');
	const corrected = await innerSize(window);
	if (corrected.width !== width || corrected.height !== height)
		throw new Error(
			`Viewport ${String(corrected.width)}x${String(corrected.height)} after one correction (first ${String(first.width)}x${String(first.height)}), wanted ${String(width)}x${String(height)}`,
		);
}

// Review evidence only, when BOARD_UI_RECORD names a folder (board-ui-harness.ts keeps the parsed
// measurements there too): each case's screenshot, and every lane's box with its first card's
// box and actions row, so a layout change can be shown row by row rather than only as a verdict.
const record = process.env['BOARD_UI_RECORD'];
let kept = 0;
async function keepEvidence(window: BrowserWindow, folder: string, name: string): Promise<void> {
	const image = await window.webContents.capturePage();
	await writeFile(join(folder, `${name}.png`), image.toPNG());
	const lanes = (await window.webContents
		.executeJavaScript(`[...document.querySelectorAll('.board-lane')].map((lane) => {
		const box = (element) => element ? (({ top, bottom, left, width, height }) => ({ top, bottom, left, width, height }))(element.getBoundingClientRect()) : null;
		const card = lane.querySelector('.board-card');
		return { state: lane.dataset.state ?? '?', lane: box(lane), card: box(card), actions: box(card?.querySelector('.board-card-actions') ?? null) };
	})`)) as unknown;
	await writeFile(join(folder, `${name}-lanes.json`), JSON.stringify(lanes, null, '\t'));
}

void app.whenReady().then(async () => {
	const window = new BrowserWindow({
		show: false,
		useContentSize: true,
		webPreferences: { offscreen: true, sandbox: true },
	});
	try {
		for (const { height, room, width } of cases) {
			await fitViewport(window, width, height);
			await window.loadFile(join(root, 'index.html'), { search: room ? 'room' : '' });
			window.webContents.focus();
			let title = '';
			let pressed = '';
			let forced = '';
			for (let waited = 0; waited < 10000 && !title.startsWith(`${marker} `); waited += 50) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				title = String(await window.webContents.executeJavaScript('document.title'));
				if (title.startsWith(`${marker}_KEY `) && title !== pressed) {
					pressed = title;
					await pressEnter(window);
				}
				if (title.startsWith(`${marker}_FOCUS `) && title !== forced) {
					forced = title;
					await forceKeyboardFocus(window);
				}
			}
			if (!title.startsWith(`${marker} `)) throw new Error(`No measurement: ${title}`);
			// The size reported is the one the page was measured at, read from the renderer itself, and
			// it must still be exactly the size asked for; a page that moved off it measured nothing valid.
			const viewport = await innerSize(window);
			if (viewport.width !== width || viewport.height !== height)
				throw new Error(
					`Page viewport ${String(viewport.width)}x${String(viewport.height)}, wanted ${String(width)}x${String(height)}`,
				);
			if (record) await keepEvidence(window, record, `${marker}-${String(++kept)}`);
			const measured = JSON.parse(title.slice(marker.length + 1)) as object;
			console.log(
				`${marker} ${JSON.stringify({ ...measured, height: viewport.height, room, width: viewport.width })}`,
			);
		}
	} catch (error: unknown) {
		console.error(error);
		process.exitCode = 1;
	} finally {
		window.destroy();
		app.quit();
	}
});
