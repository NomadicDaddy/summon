import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('Missing disposable fixture root');
app.setPath('userData', join(root, 'electron-profile'));
app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
	const window = new BrowserWindow({
		show: false,
		width: 320,
		height: 900,
		webPreferences: { offscreen: true, sandbox: true },
	});
	try {
		await window.loadFile(join(root, 'watchdog.html'));
		// The renderer fixture awaits its copy checks, so poll for its verdict rather than read once.
		let title: unknown = '';
		for (let waited = 0; waited < 6000; waited += 100) {
			title = (await window.webContents.executeJavaScript('document.title')) as unknown;
			if (title === 'WATCHDOG_UI_PASS' || String(title).startsWith('FAIL')) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		if (title !== 'WATCHDOG_UI_PASS')
			throw new Error(`Renderer fixture failed: ${String(title)}`);
		console.log('WATCHDOG_UI_PASS');
	} catch (error: unknown) {
		console.error(error);
		process.exitCode = 1;
	} finally {
		window.destroy();
		app.quit();
	}
});
