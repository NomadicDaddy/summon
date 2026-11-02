import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

app.setPath('userData', join(process.argv[2] ?? '', 'profile'));
void app.whenReady().then(async () => {
	const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
	try {
		await window.loadFile(join(process.argv[2] ?? '', 'index.html'));
		const result: unknown = await window.webContents.executeJavaScript('window.filterTest');
		console.log(JSON.stringify(result));
		app.exit(0);
	} catch (error) {
		console.error(error);
		app.exit(1);
	}
});
