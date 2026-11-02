import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('Missing disposable fixture root');
app.setPath('userData', join(root, 'electron-profile'));
app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
	const window = new BrowserWindow({
		show: false,
		width: 1200,
		height: 800,
		webPreferences: { offscreen: true, sandbox: true },
	});
	try {
		await window.loadFile(join(root, 'clip.html'));
		// Focus a box planted well below the window, as a terminal's cursor-following input can be,
		// then report whether anything scrolled the page.
		const result = (await window.webContents.executeJavaScript(`(() => {
			const box = document.getElementById('below');
			box.focus();
			box.scrollIntoView();
			const se = document.scrollingElement;
			return JSON.stringify({
				focused: document.activeElement === box,
				page: se.scrollTop,
				body: document.body.scrollTop,
				terminals: document.getElementById('terminals').scrollTop,
				bodyTop: document.body.getBoundingClientRect().top,
				// The page must have nothing to scroll at all, so a later min-height cannot undo this.
				pageFits: se.scrollHeight <= innerHeight,
			});
		})()`)) as string;
		console.log(`WINDOW_CLIP ${result}`);
	} catch (error: unknown) {
		console.error(error);
		process.exitCode = 1;
	} finally {
		window.destroy();
		app.quit();
	}
});
