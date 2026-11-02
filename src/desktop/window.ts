import { BrowserWindow, clipboard } from 'electron';
import { fileURLToPath } from 'node:url';

import { storageRoot } from '../store.ts';
import { isTextPaste } from './paste.ts';

export function createTeamWindow(onError: (error: unknown) => void): BrowserWindow {
	const window = new BrowserWindow({
		width: 1280,
		height: 820,
		minWidth: 760,
		minHeight: 480,
		backgroundColor: '#101518',
		// Without this Electron ships its own stock mark, which is what the taskbar and title bar
		// showed. The .ico carries seven sizes because Windows picks per surface rather than
		// scaling one image, and the 16 and 24px entries are drawn from icons/summon-small.svg, a
		// wider bell, so it still reads as a bell at taskbar size.
		icon: fileURLToPath(new URL('./icons/summon.ico', import.meta.url)),
		title: `summon · ${storageRoot()}`,
		show: false,
		webPreferences: {
			preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	window.setMenu(null);
	window.on('page-title-updated', (event) => event.preventDefault());
	window.webContents.on('before-input-event', (event, input) => {
		if (!isTextPaste(input)) return;
		event.preventDefault();
		void clipboard
			.readText()
			.then(async (text) => {
				if (window.isDestroyed()) return;
				if (text || !(await clipboard.has('image/png'))) window.webContents.paste();
				else window.webContents.send('team:image-paste');
			})
			.catch(onError);
	});
	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	window.webContents.on('will-navigate', (event) => event.preventDefault());
	window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
		callback(false),
	);
	return window;
}
